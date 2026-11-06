import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

// SCO-1098: a codex_local turn runs in the Codex Remote Control daemon, not in the server's
// codex-acp child. A hot restart kills that child without an interrupt (the daemon keeps the
// turn), and the next server re-enters the same run here: it waits for the daemon turn and
// reports its outcome instead of starting a new prompt.

const CODEX_RC_LAUNCHER = "codex-acp-rc";
const POLL_MS = 5_000;

export function isCodexRcConfig(config: Record<string, unknown>): boolean {
  const engine = typeof config.engine === "string" ? config.engine.trim().toLowerCase() : "";
  const raw = typeof config.agentCommand === "string" && config.agentCommand.trim()
    ? config.agentCommand : typeof config.acpAgentCommand === "string" ? config.acpAgentCommand : "";
  return engine !== "cli" && path.basename(raw.trim().split(/\s+/)[0] ?? "") === CODEX_RC_LAUNCHER;
}

// Runs whose codex-acp bridge was killed for a hot restart. Their old-server execution must
// never settle: the run row stays `running` for the next server to re-enter.
const detachedRunIds = new Set<string>();

export function markCodexRunDetachedForRestart(runId: string) {
  detachedRunIds.add(runId);
}

export function holdIfDetachedForRestart<T>(runId: string, execution: Promise<T>): Promise<T> {
  const hold = () => new Promise<T>(() => {});
  return execution.then(
    value => (detachedRunIds.has(runId) ? hold() : value),
    error => (detachedRunIds.has(runId) ? hold() : Promise.reject(error)),
  );
}

type Rpc = (method: string, params: Record<string, unknown>) => Promise<any>;

function connectDaemon(socketPath: string): Promise<{ rpc: Rpc; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost/", { createConnection: () => net.connect(socketPath) });
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    let seq = 0;
    const fail = (error: Error) => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    };
    const rpc: Rpc = (method, params) => new Promise((res, rej) => {
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error("Codex daemon disconnected"));
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, 30_000);
      pending.set(id, { resolve: res, reject: rej, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on("message", chunk => {
      let msg: any;
      try { msg = JSON.parse(String(chunk)); } catch { return; }
      const p = msg?.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message ?? "Codex RPC failed")) : p.resolve(msg.result);
    });
    ws.on("error", error => { fail(error); reject(error); });
    ws.on("close", () => fail(new Error("Codex daemon connection closed")));
    ws.on("open", async () => {
      try {
        await rpc("initialize", { clientInfo: { name: "paperclip_restart_reattach", title: "Paperclip restart reattach", version: "0.1.0" }, capabilities: { experimentalApi: true } });
        ws.send(JSON.stringify({ method: "initialized", params: {} }));
        resolve({ rpc, close: () => ws.close() });
      } catch (error) { ws.close(); reject(error as Error); }
    });
  });
}

type Turn = { id: string; status: string; startedAt?: number | null; error?: { message?: string } | null; items?: Array<Record<string, unknown>> };

/** The run's own turn is the first one started after the run began; later turns belong to other clients. */
export function selectRunTurn(turns: Turn[], runStartedAtMs: number | null): Turn | null {
  if (turns.length === 0) return null;
  if (runStartedAtMs === null) return turns.at(-1) ?? null;
  return turns.find(t => typeof t.startedAt === "number" && t.startedAt * 1000 >= runStartedAtMs - 5_000) ?? null;
}

export function finalAgentText(turn: Turn): string {
  const messages = (turn.items ?? []).filter(i => i.type === "agentMessage" && typeof i.text === "string");
  const final = messages.findLast(i => i.phase === "final_answer") ?? messages.at(-1);
  return typeof final?.text === "string" ? final.text : "";
}

export async function reattachCodexRcTurn(
  ctx: AdapterExecutionContext,
  options: { socketPath?: string; pollMs?: number } = {},
): Promise<AdapterExecutionResult> {
  const session = (ctx.context.paperclipRestartReattachSession ?? {}) as Record<string, unknown>;
  const threadId = typeof session.sessionId === "string" ? session.sessionId : "";
  const startedAt = typeof ctx.context.paperclipRestartReattachRunStartedAt === "string"
    ? Date.parse(ctx.context.paperclipRestartReattachRunStartedAt) : NaN;
  const sessionFields = {
    sessionId: threadId || null,
    sessionDisplayId: threadId || null,
    sessionParams: (session.sessionParams as Record<string, unknown> | undefined) ?? null,
  };
  const failure = (errorCode: string, errorMessage: string, extra: Record<string, unknown> = {}): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage, ...sessionFields,
    resultJson: { codexRcReattach: { threadId, outcome: errorCode }, ...extra },
  });
  if (!threadId) return failure("codex_rc_reattach_unavailable", "Hot-restart re-entry found no recorded Codex thread for this run.");

  let connection: Awaited<ReturnType<typeof connectDaemon>>;
  try {
    connection = await connectDaemon(options.socketPath ?? path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock"));
  } catch (error) {
    return failure("codex_rc_reattach_unavailable", `Codex Remote Control daemon unreachable for re-entry: ${(error as Error).message}`);
  }
  try {
    const readTurn = async () => {
      const read = await connection.rpc("thread/read", { threadId, includeTurns: true });
      return selectRunTurn((read?.thread?.turns ?? []) as Turn[], Number.isFinite(startedAt) ? startedAt : null);
    };
    let turn = await readTurn();
    if (!turn) return failure("codex_rc_reattach_unavailable", `Codex thread ${threadId} has no turn started by this run.`);
    const turnId = turn.id;
    await ctx.onLog("stdout", `[paperclip] Rejoined Codex Remote Control turn ${turnId} on thread ${threadId} after a server restart; waiting for it to finish.\n`);
    while (turn.status === "inProgress") {
      // Another hot restart detached this run: stop watching without an interrupt; the hold keeps it running.
      if (detachedRunIds.has(ctx.runId)) return failure("codex_rc_reattach_detached", "Detached for another server restart");
      if (ctx.signal?.aborted) {
        await connection.rpc("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        return { exitCode: null, signal: "SIGTERM", timedOut: false, errorCode: "cancelled", errorMessage: "Run cancelled while rejoined to its Codex turn", ...sessionFields,
          resultJson: { codexRcReattach: { threadId, turnId, outcome: "interrupt_requested" } } };
      }
      await new Promise(r => setTimeout(r, options.pollMs ?? POLL_MS));
      const status = await connection.rpc("thread/read", { threadId, includeTurns: false });
      if (status?.thread?.status?.type === "active") continue;
      turn = (await readTurn()) ?? turn;
      if (turn.id !== turnId) break;
    }
    const text = finalAgentText(turn);
    if (text) await ctx.onLog("stdout", `${text}\n`);
    const recovery = { codexRcReattach: { threadId, turnId, outcome: turn.status } };
    if (turn.status === "completed") {
      return { exitCode: 0, signal: null, timedOut: false, ...sessionFields, summary: text || "completed",
        resultJson: { ...recovery, stopReason: "end_turn", result: text } };
    }
    // The daemon stopped the turn; the thread persists, so the next wake resumes it.
    return failure(turn.status === "interrupted" ? "codex_turn_interrupted" : "codex_turn_failed",
      turn.error?.message ?? `Codex turn ${turnId} ended ${turn.status} while the server restarted.`,
      { ...recovery, executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } });
  } catch (error) {
    return failure("codex_rc_reattach_lost", `Lost the Codex daemon while rejoined: ${(error as Error).message}`);
  } finally {
    connection.close();
  }
}
