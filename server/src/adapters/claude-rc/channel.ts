/**
 * Persistent Claude Code channel transport. The MCP child owns notification
 * emission, while Paperclip submits through the bridge-ctl stdin control path.
 * A local write is NOT an acknowledgement: only the UserPromptSubmit hook is.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CHANNEL_NAME = "pcbridge";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type ChannelStage = "inbox_pending" | "reserved" | "push_started" | "emitted_local" | "hook_observed" | "terminal";
export type ChannelStatus = {
  op_id: string;
  stage: ChannelStage;
  hook_observed: boolean;
  held_unknown_effect: boolean;
  receipt: unknown;
};
export type ChannelHost = {
  dir: string;
  root: string;
  mcpConfigPath: string;
  hookSettingsPath: string;
  control: (args: string[], input?: string) => Promise<{ code: number; output: string }>;
  ready: () => Promise<boolean>;
  status: (opId: string) => Promise<ChannelStatus | null>;
  submit: (opId: string, prompt: string) => Promise<{ ok: boolean; error?: string }>;
};

function quoteShell(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function findBridgeRoot(explicit?: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = explicit ? [path.resolve(explicit)] : [
    path.resolve(process.cwd(), "packages/claude-channel-bridge"),
    path.resolve(process.cwd(), "../packages/claude-channel-bridge"),
    path.resolve(here, "../../../../packages/claude-channel-bridge"),
    path.resolve(here, "../../../../../packages/claude-channel-bridge"),
  ];
  for (const p of candidates) {
    try {
      await Promise.all(["server.cjs", "hook.cjs", "bin/bridge-ctl.cjs"].map(f => fs.access(path.join(p, f))));
      return p;
    } catch { /* Try the next source/deployed-repo layout. */ }
  }
  throw new Error("Claude channel bridge files unavailable; no TUI session was started");
}

/** Per-host files contain absolute paths and a server name only, never auth. */
export async function prepareChannelHost(stateDir: string, root: string): Promise<ChannelHost> {
  const dir = path.join(stateDir, "channel-bridge");
  const mcpConfigPath = path.join(stateDir, "channel-mcp-config.json");
  const hookSettingsPath = path.join(stateDir, "channel-hook-settings.json");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const mcp = {
    mcpServers: {
      [CHANNEL_NAME]: {
        command: process.execPath,
        args: [path.join(root, "server.cjs")],
        env: { PC_BRIDGE_DIR: dir, PC_BRIDGE_SERVER: CHANNEL_NAME },
      },
    },
  };
  const events = ["UserPromptSubmit", "PostToolUse", "Stop", "SessionStart"] as const;
  const hooks = Object.fromEntries(events.map(event => {
    const command = [
      `PC_BRIDGE_DIR=${quoteShell(dir)}`,
      `PC_BRIDGE_SERVER=${quoteShell(CHANNEL_NAME)}`,
      quoteShell(process.execPath),
      quoteShell(path.join(root, "hook.cjs")),
      event,
    ].join(" ");
    return [event, [{ ...(event === "SessionStart" ? { matcher: "startup|resume" } : {}),
      hooks: [{ type: "command", command, timeout: 5 }] }]];
  }));
  // --settings loads these additional hooks without rewriting ~/.claude/settings.json.
  // [ASSUMPTION] Additional CLI settings merge rather than replace user hooks.
  await fs.writeFile(mcpConfigPath, JSON.stringify(mcp, null, 2) + "\n", { mode: 0o600 });
  await fs.writeFile(hookSettingsPath, JSON.stringify({ hooks }, null, 2) + "\n", { mode: 0o600 });
  await Promise.all([fs.chmod(mcpConfigPath, 0o600), fs.chmod(hookSettingsPath, 0o600)]);

  const ctl = path.join(root, "bin/bridge-ctl.cjs");
  const control = (args: string[], input?: string) => new Promise<{ code: number; output: string }>((resolve, reject) => {
    // Pass only public op IDs and paths in argv/env. Prompts flow over stdin.
    const child = spawn(process.execPath, [ctl, ...args], {
      env: { PATH: process.env.PATH || "/usr/bin:/bin", PC_BRIDGE_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    let complete = false;
    const timer = setTimeout(() => {
      if (!complete) { complete = true; reject(new Error("bridge-ctl timed out; outcome unknown, no retry")); }
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; if (output.length > 64_000) output = output.slice(-64_000); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { error += chunk; if (error.length > 1_000) error = error.slice(-1_000); });
    child.on("error", err => {
      if (!complete) { complete = true; clearTimeout(timer); reject(err); }
    });
    child.on("close", code => {
      if (!complete) {
        complete = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, output: output.trim() || error.trim() });
      }
    });
    // EPIPE is handled by close/error; do not re-submit on ambiguous failure.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

  return {
    dir, root, mcpConfigPath, hookSettingsPath, control,
    ready: async () => {
      try {
        const r = JSON.parse(await fs.readFile(path.join(dir, "ready.json"), "utf8")) as {
          server?: string; initialized?: boolean; pid?: number; observed_at?: number;
        };
        if (r.server !== CHANNEL_NAME || !r.initialized ||
            !Number.isInteger(r.pid) || (r.pid ?? 0) <= 1 ||
            typeof r.observed_at !== "number" ||
            Math.abs(Date.now() - r.observed_at) > 3_000) return false;
        process.kill(r.pid!, 0); // Existence probe only, NOT a signal.
        return true;
      } catch { return false; }
    },
    status: async (opId) => {
      const r = await control(["status", opId]);
      if (r.code !== 0) throw new Error("bridge status failed; no replay");
      const v: unknown = JSON.parse(r.output);
      if (v === null) return null;
      if (!v || typeof v !== "object" || (v as ChannelStatus).op_id !== opId) throw new Error("bridge status malformed");
      return v as ChannelStatus;
    },
    submit: async (opId, prompt) => {
      const r = await control(["submit", opId, "--stdin"], prompt);
      let response: { ok: boolean; error?: string };
      try { response = JSON.parse(r.output); }
      catch { throw new Error("bridge submit outcome unknown; no replay"); }
      if (r.code !== 0 || !response.ok) {
        throw new Error(`bridge refused op ${opId}: ${response.error || "unknown"}; no replay`);
      }
      return response;
    },
  };
}

export type ChannelIO = {
  ready(): Promise<boolean>;
  status(opId: string): Promise<ChannelStatus | null>;
  submit(opId: string, prompt: string): Promise<{ ok: boolean }>;
  fallback(): Promise<void>;
};

/**
 * Rejoin is side-effect-free. Once the active checkpoint exists we never
 * retry an uncertain submit, including crashes before ledger reservation.
 * All fallback safety checks and mode journaling live in fallback().
 */
export async function routeChannelInput(
  opId: string, prompt: string, adopted: boolean, io: ChannelIO,
  opts: { readyWaitMs?: number; hookWaitMs?: number; pollMs?: number } = {},
): Promise<"adopted" | "channel" | "tmux-fallback"> {
  if (adopted) return "adopted";
  // Also guard against a lost active.json with a durable, already-used op_id.
  if (await io.status(opId)) throw new Error(`bridge op ${opId} already exists; never re-submit`);
  const pollMs = opts.pollMs ?? 250;
  const readinessDeadline = Date.now() + (opts.readyWaitMs ?? 8_000);
  let ready = await io.ready();
  while (!ready && Date.now() < readinessDeadline) {
    await sleep(pollMs);
    ready = await io.ready();
  }
  if (!ready) {
    // Before fallback, make sure another actor did not reserve the op.
    if (await io.status(opId)) throw new Error("bridge op appeared while unavailable; no fallback or replay");
    await io.fallback(); // Guarded empty+idle TUI; checkpoint updated BEFORE paste.
    return "tmux-fallback";
  }
  await io.submit(opId, prompt); // Promise rejection is an UNKNOWN effect; never fallback.
  const deadline = Date.now() + (opts.hookWaitMs ?? 15_000);
  while (true) {
    const status = await io.status(opId);
    if (status?.hook_observed === true) return "channel"; // terminal without a hook is never acknowledgement
    if (status?.held_unknown_effect) throw new Error("bridge op held in unknown-effect state; operator reconciliation required");
    if (Date.now() >= deadline) {
      throw new Error(`bridge op ${opId} was not hook-observed; held for reconciliation, no TUI replay`);
    }
    await sleep(pollMs);
  }
}
