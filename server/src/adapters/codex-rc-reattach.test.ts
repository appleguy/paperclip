import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { holdIfDetachedForRestart, isCodexRcConfig, markCodexRunDetachedForRestart, reattachCodexRcTurn, selectRunTurn } from "./codex-rc-reattach.js";

const RUN_START = Date.parse("2026-11-06T02:40:00Z");
const turn = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "turn-1", status, startedAt: RUN_START / 1000 + 2, error: null,
  items: status === "completed" ? [{ type: "agentMessage", text: "done: SCO-1 shipped", phase: "final_answer" }] : [],
  ...extra,
});

let cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

async function fakeDaemon(statuses: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rc-"));
  const socketPath = path.join(dir, "d.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const calls: string[] = [];
  let reads = 0;
  wss.on("connection", ws => ws.on("message", raw => {
    const m = JSON.parse(String(raw));
    if (m.id === undefined) return;
    calls.push(m.method);
    let result: unknown = {};
    if (m.method === "thread/read") {
      const status = statuses[Math.min(reads++, statuses.length - 1)]!;
      result = m.params.includeTurns
        ? { thread: { status: { type: status === "inProgress" ? "active" : "idle" }, turns: [turn(status)] } }
        : { thread: { status: { type: status === "inProgress" ? "active" : "idle" } } };
    }
    ws.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise<void>(r => server.listen(socketPath, r));
  cleanup.push(() => { wss.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, calls };
}

function ctx(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    logs,
    value: {
      runId: "run-1",
      context: {
        paperclipRestartReattach: true,
        paperclipRestartReattachSession: { sessionId: "thread-1", sessionParams: { acpSessionId: "thread-1" } },
        paperclipRestartReattachRunStartedAt: new Date(RUN_START).toISOString(),
        ...overrides,
      },
      onLog: async (_s: string, chunk: string) => { logs.push(chunk); },
    } as any,
  };
}

describe("codex RC restart reattach", () => {
  it("waits for the daemon turn and reports its final answer under the same session", async () => {
    const daemon = await fakeDaemon(["inProgress", "inProgress", "completed"]);
    const c = ctx();
    const result = await reattachCodexRcTurn(c.value, { socketPath: daemon.socketPath, pollMs: 5 });
    expect(result).toMatchObject({ exitCode: 0, summary: "done: SCO-1 shipped", sessionId: "thread-1", sessionParams: { acpSessionId: "thread-1" } });
    expect(daemon.calls).not.toContain("turn/start");
    expect(c.logs.join("")).toContain("Rejoined Codex Remote Control turn turn-1");
  });

  it("stops watching without an interrupt when another restart detaches it", async () => {
    const daemon = await fakeDaemon(["inProgress"]);
    const c = ctx();
    c.value.runId = "run-redetached";
    const watching = reattachCodexRcTurn(c.value, { socketPath: daemon.socketPath, pollMs: 5 });
    await new Promise(r => setTimeout(r, 30));
    markCodexRunDetachedForRestart("run-redetached");
    expect(await watching).toMatchObject({ errorCode: "codex_rc_reattach_detached" });
    expect(daemon.calls).not.toContain("turn/interrupt");
  });

  it("finalizes a turn that completed while the server was down", async () => {
    const daemon = await fakeDaemon(["completed"]);
    const result = await reattachCodexRcTurn(ctx().value, { socketPath: daemon.socketPath, pollMs: 5 });
    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({ codexRcReattach: { turnId: "turn-1", outcome: "completed" } });
  });

  it("reports an interrupted daemon turn as a preserved-session failure", async () => {
    const daemon = await fakeDaemon(["interrupted"]);
    const result = await reattachCodexRcTurn(ctx().value, { socketPath: daemon.socketPath, pollMs: 5 });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "codex_turn_interrupted" });
  });

  it("fails closed without a recorded thread", async () => {
    const result = await reattachCodexRcTurn(ctx({ paperclipRestartReattachSession: {} }).value, { socketPath: "/nonexistent" });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "codex_rc_reattach_unavailable" });
  });

  it("ignores turns that started before the run", () => {
    expect(selectRunTurn([{ id: "old", status: "completed", startedAt: RUN_START / 1000 - 600 }], RUN_START)).toBeNull();
    expect(selectRunTurn([
      { id: "old", status: "completed", startedAt: RUN_START / 1000 - 600 },
      { id: "mine", status: "inProgress", startedAt: RUN_START / 1000 + 3 },
      { id: "later", status: "inProgress", startedAt: RUN_START / 1000 + 900 },
    ], RUN_START)?.id).toBe("mine");
  });

  it("recognizes only the RC shim launcher", () => {
    expect(isCodexRcConfig({ agentCommand: "/Volumes/NVM/Paperclip/ops/codex-remote-control/codex-acp-rc" })).toBe(true);
    expect(isCodexRcConfig({ agentCommand: "codex-acp" })).toBe(false);
    expect(isCodexRcConfig({ engine: "cli", agentCommand: "codex-acp-rc" })).toBe(false);
  });

  it("never settles an execution detached for restart", async () => {
    markCodexRunDetachedForRestart("run-detached");
    const settled = await Promise.race([
      holdIfDetachedForRestart("run-detached", Promise.reject(new Error("bridge killed"))).then(() => "settled", () => "settled"),
      new Promise(r => setTimeout(() => r("held"), 20)),
    ]);
    expect(settled).toBe("held");
    await expect(holdIfDetachedForRestart("run-live", Promise.resolve(7))).resolves.toBe(7);
  });
});
