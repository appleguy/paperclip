import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** No inference is sent by this attempt when session safety is unverified. Never
 * manufacture a new session when the old provider might still be executing. */
export class OpenCodeSharedSessionWait extends Error {
  constructor() {
    super("OpenCode shared server has unresolved active sessions; no inference sent");
    this.name = "OpenCodeSharedSessionWait";
  }
}

type Binding = {
  version: 1;
  agentId: string;
  taskId: string;
  runId: string;
  cwd: string;
  url: string;
  sessionId: string;
  /** Set only after the bound CLI exited cleanly; absent means the run may have died mid-turn. */
  exited?: "clean";
};

type Input = {
  configPath: string;
  stateDir: string;
  agentId: string;
  taskId: string;
  runId: string;
  cwd: string;
  requestedSessionId: string | null;
  signal?: AbortSignal;
};

type Active = Record<string, { type?: string }>;

const sessionIdPattern = /^ses_[a-zA-Z0-9_-]{6,100}$/;

export async function prepareSharedOpenCodeSession(input: Input) {
  // A saved configuration is an explicit local opt-in. Forbid remote addresses
  // and redirects: a password may never be forwarded away from loopback.
  const cfg = JSON.parse(await fs.readFile(input.configPath, "utf8")) as Record<string, unknown>;
  const url = cfg.url;
  const passwordFile = cfg.passwordFile;
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(url) ||
      typeof passwordFile !== "string" || !path.isAbsolute(passwordFile)) {
    throw new OpenCodeSharedSessionWait();
  }
  const password = (await fs.readFile(passwordFile, "utf8")).trim();
  if (!password || password.length > 4096) throw new OpenCodeSharedSessionWait();
  const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const call = async (method: string, endpoint: string, body?: unknown) => {
    let res: Response;
    try {
      res = await fetch(url + "/api" + endpoint, {
        method,
        headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(7_000),
        redirect: "error",
      });
      if (!res.ok) throw new OpenCodeSharedSessionWait();
      const json: unknown = await res.json();
      return json && typeof json === "object" && !Array.isArray(json) &&
        "data" in json ? (json as Record<string, unknown>).data : json;
    } catch {
      // Never propagate the provider URL, Basic authorization or raw body.
      throw new OpenCodeSharedSessionWait();
    }
  };
  const active = async (): Promise<Active> => {
    const raw = await call("GET", "/session/active");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpenCodeSharedSessionWait();
    return raw as Active;
  };
  const running = (states: Active) =>
    Object.entries(states).filter(([, status]) => !status ||
      typeof status !== "object" || status.type !== "idle").map(([id]) => id);

  const dir = path.join(input.stateDir, "paperclip-opencode-session-recovery");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = `${input.agentId}-${input.taskId}`;
  if (!/^[a-zA-Z0-9_-]{1,130}$/.test(key)) throw new OpenCodeSharedSessionWait();
  const savedPath = path.join(dir, key + ".json");
  let old: Binding | null = null;
  try {
    const value: unknown = JSON.parse(await fs.readFile(savedPath, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Binding;
      if (v.version === 1 && v.agentId === input.agentId && v.taskId === input.taskId &&
          v.url === url && v.cwd === input.cwd && sessionIdPattern.test(v.sessionId))
        old = v;
      else throw new OpenCodeSharedSessionWait();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OpenCodeSharedSessionWait();
  }

  if (old && input.requestedSessionId && input.requestedSessionId !== old.sessionId)
    throw new OpenCodeSharedSessionWait();
  const selected = old?.sessionId ?? input.requestedSessionId;
  if (selected && !sessionIdPattern.test(selected)) throw new OpenCodeSharedSessionWait();
  const states = await active();
  if (running(states).some(sid => sid !== selected)) throw new OpenCodeSharedSessionWait();
  // Idle is only a snapshot; it does not prove that an interrupted predecessor
  // has finished or that its delayed submission cannot still reach the server.
  if (old && old.exited !== "clean") throw new OpenCodeSharedSessionWait();

  let sessionId = selected;
  const resumed = sessionId !== null;
  if (resumed) {
    const session = await call("GET", "/session/" + sessionId);
    if (!session || typeof session !== "object" || (session as Record<string, unknown>).id !== sessionId)
      throw new OpenCodeSharedSessionWait();
  } else {
    const created = await call("POST", "/session", { location: { directory: input.cwd } });
    const id = created && typeof created === "object" ? (created as Record<string, unknown>).id : null;
    if (typeof id !== "string" || !sessionIdPattern.test(id)) throw new OpenCodeSharedSessionWait();
    sessionId = id;
  }
  // A task/session binding is not a message-level interrupt fence. A newer
  // turn (including one from an outside client) can occupy this same session.
  const ownedSessionId = sessionId!;
  if (resumed && running(states).includes(ownedSessionId)) {
    throw new OpenCodeSharedSessionWait();
  }

  const binding: Binding = { version: 1, agentId: input.agentId, taskId: input.taskId,
    runId: input.runId, cwd: input.cwd, url, sessionId: sessionId! };
  const persist = async (value: Binding) => {
    const temporary = savedPath + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, savedPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  };
  await persist(binding);
  // Only a predecessor that did not record a clean exit is a crash/restart
  // recovery. Ordinary follow-up wakes resume the same session normally.
  const recovered = old !== null && old.exited !== "clean";
  return {
    sessionId: sessionId!,
    resumed,
    recovered,
    /** Preserve the binding until issue archival, including after exit 0. */
    async finish(outcome: { exitCode: number | null; signal: string | null; timedOut: boolean }) {
      if (outcome.exitCode !== 0 || outcome.signal || outcome.timedOut || input.signal?.aborted) {
        // Local CLI exit does not prove a shared provider turn stopped.
        return { providerWorkUnverified: true };
      }
      if (outcome.exitCode === 0) await persist({ ...binding, exited: "clean" });
      // A clean client exit is not proof the Paperclip run result was committed.
      // Preserve the exact provider session binding for a successor after a
      // crash between CLI completion and durable run settlement. Retire it only
      // as part of an authoritative task/session archival operation.
      return { providerWorkUnverified: false };
    },
  };
}
