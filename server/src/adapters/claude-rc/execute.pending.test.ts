import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { ChannelHost } from "./channel.js";

const deps = vi.hoisted(() => ({ tmux: vi.fn(), settle: vi.fn(), submit: vi.fn(), host: null as ChannelHost | null }));
vi.mock("../agy/execute.js", async original => ({
  ...await original<typeof import("../agy/execute.js")>(), tmux: deps.tmux,
}));
vi.mock("./settlement.js", async original => ({
  ...await original<typeof import("./settlement.js")>(), settleOutcome: deps.settle,
}));
vi.mock("./channel.js", async original => {
  const channel = await original<typeof import("./channel.js")>();
  return { ...channel, prepareChannelHost: async (dir: string, root: string) => {
    const host = await channel.prepareChannelHost(dir, root);
    deps.submit.mockImplementation(host.submit);
    deps.host = { ...host, ready: async () => true, submit: deps.submit };
    return deps.host;
  } };
});
vi.mock("./done-gate.js", async original => ({
  ...await original<typeof import("./done-gate.js")>(), gateReceiptRaw: async () => ({ ok: true, reasons: [], notes: [] }),
}));
vi.mock("./done-gate-provenance.js", async original => ({
  ...await original<typeof import("./done-gate-provenance.js")>(), captureDoneGateBaseline: async () => ({ repos: [] }),
}));
import { execute, projectDir } from "./execute.js";
import { findBridgeRoot, prepareChannelHost } from "./channel.js";
import { receiptFilePath } from "../agy/execute.js";

let dir: string;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("pending Claude RC native delivery", () => {
  it("marks restart adoption as dispatched before waiting and preserves ownership on cancellation", async () => {
    dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1044-adopt-");
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const cwd = path.join(dir, "workspace");
    const stateDir = path.join(dir, "state");
    const runId = "11111111-1111-4111-8111-111111111111";
    const rcUrl = "https://claude.ai/code/session_original";
    await fs.mkdir(stateDir, { recursive: true });
    const host = await prepareChannelHost(stateDir, await findBridgeRoot());
    await host.submit(runId, "already submitted original work");
    deps.submit.mockClear();
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "capture-pane") return `${rcUrl}\n✻ Thinking… (esc to interrupt)\n❯ \n  bypass permissions on`;
      if (args[0] === "display-message") return "claude";
      return "";
    });
    const checkpoint = JSON.stringify({ runId, op_id: runId, issueId: "pending-issue", rcUrl, cwd,
      conversationId: "original-conversation", receiptPath: receiptFilePath(stateDir, runId), dispatchMode: "channel-pending" });
    await fs.writeFile(path.join(stateDir, "active.json"), checkpoint);
    const abort = new AbortController();
    const ctx = { agent: { id: "agent", name: "Original seat", companyId: "company" }, runId,
      config: { cwd, stateDir, tmuxSocket: "socket", tmuxSession: "original-seat" },
      context: { issueId: "pending-issue", paperclipRestartReattach: true },
      authToken: "test-only-token", signal: abort.signal, onLog: vi.fn(), onDispatch: vi.fn(),
    } as unknown as AdapterExecutionContext;
    const run = execute(ctx);
    try {
      await vi.waitFor(() => expect(ctx.onDispatch).toHaveBeenCalledOnce(), { timeout: 5000 });
      abort.abort();
      const result = await run;
      expect(result.errorMessage).toContain("pending op retained");
      expect(result.executionRecovery).toBeUndefined();
      expect(deps.submit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).toBe(checkpoint);
      expect(await host.status(runId)).toMatchObject({ stage: "inbox_pending" });
    } finally { abort.abort(); await run; }
  });

  it("keeps the same live run, session and checkpoint through busy-to-idle and settles once", async () => {
    dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1044-");
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    deps.settle.mockResolvedValue({ status: "done" });
    deps.submit.mockClear();
    deps.settle.mockClear();
    const cwd = path.join(dir, "workspace");
    const stateDir = path.join(dir, "state");
    const session = "original-conversation";
    const seatName = `sco1021-${path.basename(dir)}`;
    const rcUrl = "https://claude.ai/code/session_original";
    let busy = true;
    let created = false;
    deps.tmux.mockClear();
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "has-session" && !created) throw new Error("no session");
      if (args[0] === "new-session") created = true;
      if (args[0] === "capture-pane") return `${rcUrl}\n${busy ? "✻ Thinking… (esc to interrupt)\n" : ""}❯ \n  bypass permissions on`;
      if (args[0] === "display-message") return args.at(-1) === "#{pane_current_path}" ? cwd : "claude";
      return "";
    });
    await fs.mkdir(path.join(dir, ".claude/sessions"), { recursive: true });
    await fs.mkdir(projectDir(cwd), { recursive: true });
    await fs.writeFile(path.join(projectDir(cwd), `${session}.jsonl`), "");
    await fs.writeFile(path.join(dir, ".claude/sessions/1.json"), JSON.stringify({
      pid: process.pid, sessionId: session, cwd, tmux: `${seatName}:@1.%1`, updatedAt: 1,
    }));
    const abort = new AbortController();
    const ctx = {
      agent: { id: "agent", name: "Original seat", companyId: "company" }, runId: "pending-run",
      config: { cwd, stateDir, tmuxSocket: "socket", tmuxSession: seatName, keepConversation: true },
      context: { issueId: "pending-issue" }, authToken: "test-only-token", signal: abort.signal,
      onLog: vi.fn(), onDispatch: vi.fn(),
    } as unknown as AdapterExecutionContext;
    let finished = false;
    const run = execute(ctx).then(result => { finished = true; return result; });
    try {
      await vi.waitFor(async () => expect(await deps.host?.status(ctx.runId)).toMatchObject({ stage: "inbox_pending" }), { timeout: 5000 });
      const host = deps.host!;
      const { Ledger, processInbox, handleHook } = createRequire(import.meta.url)(path.join(host.root, "lib/bridge.cjs"));
      const ledger = new Ledger(host.dir);
      const delivered: string[] = [];
      await processInbox(ledger, async (op: string) => { delivered.push(op); });
      const activePath = path.join(stateDir, "active.json");
      const checkpoint = await fs.readFile(activePath, "utf8");
      const runEnv = await fs.readFile(path.join(stateDir, "run-env.sh"), "utf8");
      const launch = deps.tmux.mock.calls.find(([, args]) => args[0] === "new-session")?.[1];
      expect(launch).toContain(`PAPERCLIP_RC_RUN_ENV=${path.join(stateDir, "run-env.sh")}`);
      expect((await fs.stat(path.join(stateDir, "run-env.sh"))).mode & 0o777).toBe(0o600);
      expect(runEnv).toContain("export PAPERCLIP_COMPANY_ID='company'");
      expect(runEnv).toContain("export PAPERCLIP_AGENT_ID='agent'");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 20 * 60_000);
      busy = false;
      handleHook(ledger, "pcbridge", "Stop", { session_id: session });
      await new Promise(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(await fs.readFile(activePath, "utf8")).toBe(checkpoint);
      expect(await fs.readFile(path.join(stateDir, "run-env.sh"), "utf8")).toBe(runEnv);
      handleHook(ledger, "pcbridge", "UserPromptSubmit", {
        session_id: session, prompt: `<channel source="pcbridge" op_id="${ctx.runId}">original work</channel>`,
      });
      await fs.writeFile(receiptFilePath(stateDir, ctx.runId), JSON.stringify({
        runId: ctx.runId, issueId: "pending-issue", status: "done", summary: "Pending op completed once",
        report: "Completed original work under the original admitted run and session. ".repeat(6),
      }));
      const result = await run;
      expect(result.errorMessage).toBeUndefined();
      expect(result).toMatchObject({ exitCode: 0, sessionId: session, resultJson: { issueClosed: true } });
      expect(deps.submit).toHaveBeenCalledOnce();
      expect(delivered).toEqual([ctx.runId]);
      expect(ctx.onDispatch).toHaveBeenCalledOnce();
      expect(deps.settle).toHaveBeenCalledExactlyOnceWith(ctx, stateDir, ctx.runId, "pending-issue", expect.objectContaining({ kind: "done" }));
      expect(deps.tmux.mock.calls.some(([, args]) => ["kill-session", "paste-buffer", "send-keys"].includes(args[0]))).toBe(false);
      await expect(fs.stat(activePath)).rejects.toThrow();
      await expect(fs.stat(path.join(stateDir, "run-env.sh"))).rejects.toThrow();
    } finally {
      abort.abort(); await run;
      await fs.rm(path.join("/Volumes/NVM/AI_Agent_Runtime/tmp", `claude-rc-${seatName}`), { recursive: true, force: true });
    }
  });
});
