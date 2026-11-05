// NAR driver for ChatGPT Web Author (SCO-1049). Wraps the blessed dispatcher
// (chatgpt-web-dispatch dispatch, M2 Chrome Beta route) behind a fixed argv: callers supply
// no command, args or binary path; only an allowlisted env subset reaches the child.
// The driver never opens a browser itself and never retries an ambiguous send. Thread and
// conversation ownership stay with the dispatcher/issue; the conversation id is a pure
// function of (agent, issue) so restart reattach is deterministic. Every submit writes a
// durable receipt before and after the spawn; readOutcome reads only that receipt.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Capabilities,
  ConvScope,
  Fence,
  HostHandle,
  ObserveEvent,
  Op,
  OutcomeRead,
  Provider,
  ProviderDriver,
  SubmitResult,
} from "./driver.js";

// Not yet in the shared Provider union; see the integration diff on SCO-1049.
export const WEB_PROVIDER = "chatgpt_web" as const;
const PROVIDER = WEB_PROVIDER as unknown as Provider;

export const DISPATCH_ARGV = ["dispatch"] as const;
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_TASK_ID",
] as const;

export interface WebExecResult {
  exitCode: number | null;
  signal?: string | null;
}
/** Port: spawn exactly file+args with exactly env. Production binds node:child_process.spawn without a shell. */
export type WebExec = (file: string, args: readonly string[], env: Record<string, string>, cwd: string) => Promise<WebExecResult>;

export interface ChatGptWebDriverOptions {
  dispatchBin: string; // operator config, never caller input
  receiptDir: string; // durable, on NVM
  exec: WebExec;
  env: Record<string, string | undefined>; // source env; filtered by ENV_ALLOWLIST
}

interface Receipt {
  opId: string;
  conversationId: string;
  phase: "started" | "exited";
  exitCode?: number | null;
  signal?: string | null;
  at: string;
}

export class WebDriverRefused extends Error {}

const SAFE = /^[A-Za-z0-9_.-]+$/;

export function webConversationId(agentId: string, issueId: string): string {
  return `web-${createHash("sha256").update(`${agentId}\0${issueId}`).digest("hex").slice(0, 16)}`;
}

export class ChatGptWebDriver implements ProviderDriver {
  constructor(private readonly o: ChatGptWebDriverOptions) {}

  capabilities(): Capabilities {
    return {
      provider: PROVIDER,
      inputKind: "rpc",
      // The dispatcher hands the task to the Web thread; no provider-side accept is observable.
      ackGrade: "emitted_local",
      receiptKinds: ["file"],
      ownerPhone: { path: "ChatGPT Web thread (M2 Chrome Beta seat)", proof: "OPEN" },
      permission: { route: "none", proof: "UNSUPPORTED" },
      resume: { byId: true, proof: "OPEN" },
      interrupt: { scoped: false, proof: "UNSUPPORTED" },
      needsPane: false,
      observeCoverage: "incomplete",
    };
  }

  async attestHost(_agentId: string, opts?: { create?: boolean }): Promise<HostHandle> {
    if (opts?.create) throw new WebDriverRefused("web author: host creation is not allowed (no new browser pairing)");
    if (!existsSync(this.o.dispatchBin)) throw new WebDriverRefused("web author: dispatcher binary missing");
    return { provider: PROVIDER, hostEpoch: 1, attested: true, detail: {} };
  }

  async bindConversation(
    _h: HostHandle,
    s: ConvScope,
    mode: "new" | "resume",
    _f: Fence,
    existingId?: string,
  ): Promise<{ conversationId: string; cwd: string; model?: string }> {
    const id = webConversationId(s.agentId, s.issueId);
    if (mode === "resume" && existingId !== id) throw new WebDriverRefused("web author: resume id does not match agent+issue");
    return { conversationId: id, cwd: s.cwd, model: s.model };
  }

  async submit(h: HostHandle, conversationId: string, op: Op, _f: Fence): Promise<SubmitResult> {
    if (h.provider !== PROVIDER) throw new WebDriverRefused("web author: wrong provider handle");
    if (op.kind !== "prompt") throw new WebDriverRefused(`web author: unsupported op kind ${op.kind}`);
    if (!SAFE.test(op.opId)) throw new WebDriverRefused("web author: unsafe opId");
    const rp = this.path(op.opId);
    if (existsSync(rp)) throw new WebDriverRefused("web author: op already submitted; not retrying");
    this.write(op.opId, { opId: op.opId, conversationId, phase: "started", at: new Date().toISOString() });
    const env: Record<string, string> = {};
    for (const k of ENV_ALLOWLIST) {
      const v = this.o.env[k];
      if (v !== undefined) env[k] = v;
    }
    const res = await this.o.exec(this.o.dispatchBin, DISPATCH_ARGV, env, "/");
    const at = new Date().toISOString();
    this.write(op.opId, { opId: op.opId, conversationId, phase: "exited", exitCode: res.exitCode, signal: res.signal ?? null, at });
    return res.exitCode === 0
      ? { grade: "emitted_local", evidence: `dispatcher exit 0 (receipt ${op.opId})`, at }
      : { grade: "outcome_unknown", evidence: `dispatcher exit ${res.exitCode ?? res.signal}`, at };
  }

  async observe(_c: string, cursor?: string) {
    return { events: [] as ObserveEvent[], next: cursor ?? "0", coverage: "incomplete" as const };
  }

  async readOutcome(_c: string, opId: string): Promise<OutcomeRead> {
    if (!SAFE.test(opId)) return "unknown";
    const r = this.read(opId);
    if (!r) return "unknown";
    if (r.phase === "started") return "unknown"; // crash window: never claim delivery
    return r.exitCode === 0 ? "receipted" : "unknown";
  }

  private path(opId: string) {
    return join(this.o.receiptDir, `${opId}.json`);
  }
  private write(opId: string, r: Receipt) {
    mkdirSync(this.o.receiptDir, { recursive: true });
    const tmp = `${this.path(opId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(r));
    renameSync(tmp, this.path(opId));
  }
  private read(opId: string): Receipt | undefined {
    try {
      return JSON.parse(readFileSync(this.path(opId), "utf8")) as Receipt;
    } catch {
      return undefined;
    }
  }
}
