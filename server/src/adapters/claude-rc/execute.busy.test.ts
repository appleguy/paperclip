import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { ChannelIO } from "./channel.js";

const deps = vi.hoisted(() => ({ tmux: vi.fn(), deliver: vi.fn(), route: vi.fn(), gate: vi.fn(), submit: vi.fn() }));
vi.mock("../agy/execute.js", async importOriginal => ({
  ...await importOriginal<typeof import("../agy/execute.js")>(),
  tmux: deps.tmux, deliver: deps.deliver,
}));
vi.mock("./channel.js", async importOriginal => ({
  ...await importOriginal<typeof import("./channel.js")>(),
  findBridgeRoot: async () => "/bridge",
  prepareChannelHost: async () => ({ status: async () => null, submit: deps.submit }),
  routeChannelInput: deps.route,
}));
vi.mock("./done-gate.js", async importOriginal => ({
  ...await importOriginal<typeof import("./done-gate.js")>(), gateReceiptRaw: deps.gate,
}));
import { execute, projectDir, typeNativeGoal } from "./execute.js";
import { receiptFilePath } from "../agy/execute.js";

const rcUrl = "https://claude.ai/code/session_busy";
const busy = `✻ Thinking… (esc to interrupt)\n❯ Press up to edit queued messages\n  bypass permissions on\n${rcUrl}`;
let dir: string;
let cwd: string;
let stateDir: string;
let screen: string;
let ctx: AdapterExecutionContext;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco947-test-");
  cwd = path.join(dir, "workspace");
  stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir);
  vi.spyOn(os, "homedir").mockReturnValue(dir);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  screen = busy;
  deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
    if (args[0] === "capture-pane") return screen;
    if (args[0] === "display-message") return args.at(-1) === "#{pane_current_path}" ? cwd : "claude";
    return "";
  });
  deps.gate.mockResolvedValue({ ok: true, reasons: [] });
  ctx = {
    agent: { id: "agent", name: "Busy seat", companyId: "company" }, runId: "run-busy",
    config: { cwd, stateDir, tmuxSocket: "socket", tmuxSession: "seat" },
    context: { issueId: "issue-busy" }, authToken: "test-token", onLog: vi.fn(),
  } as unknown as AdapterExecutionContext;
  await fs.mkdir(path.join(dir, ".claude/sessions"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude/sessions/1.json"), JSON.stringify({
    pid: process.pid, sessionId: "conversation-busy", cwd, tmux: "seat:@1.%1", updatedAt: 1,
  }));
  await fs.mkdir(projectDir(cwd), { recursive: true });
  await fs.writeFile(path.join(projectDir(cwd), "conversation-busy.jsonl"), "");
  deps.route.mockImplementation(async () => {
    await fs.writeFile(receiptFilePath(stateDir, ctx.runId), JSON.stringify({
      runId: ctx.runId, issueId: "issue-busy", status: "done", summary: "Busy receipt accepted",
      report: "Completed the assigned work with a validated receipt while the native goal continues. ".repeat(4),
    }));
    return "channel";
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SCO-947 busy delivery and completion", () => {
  it("journals possible channel effects before submit and retains intent after a crash", async () => {
    deps.route.mockImplementation(async (op: string, prompt: string, _adopted: boolean, io: ChannelIO) => {
      expect(JSON.parse(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).dispatchMode).toBe("prepared");
      return io.submit(op, prompt);
    });
    deps.submit.mockImplementation(async () => {
      expect(JSON.parse(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).dispatchMode).toBe("channel-pending");
      throw new Error("simulated submit crash");
    });
    const result = await execute(ctx);
    expect(result.errorMessage).toContain("simulated submit crash");
    expect(JSON.parse(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).dispatchMode).toBe("channel-pending");
  });

  it("journals possible tmux effects before paste and retains intent after a crash", async () => {
    deps.route.mockImplementation(async (_op: string, _prompt: string, _adopted: boolean, io: ChannelIO) => io.fallback());
    const original = deps.tmux.getMockImplementation()!;
    deps.tmux.mockImplementation(async (socket: string, args: string[]) => {
      if (args[0] === "load-buffer") {
        expect(JSON.parse(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).dispatchMode).toBe("tmux-fallback");
        throw new Error("simulated paste crash");
      }
      return original(socket, args);
    });
    const result = await execute(ctx);
    expect(result.errorMessage).toContain("simulated paste crash");
    expect(JSON.parse(await fs.readFile(path.join(stateDir, "active.json"), "utf8")).dispatchMode).toBe("tmux-fallback");
  });

  it("refuses peak-context rotation without clearing a working conversation", async () => {
    ctx.evaluateSessionPrompt = vi.fn(async () => ({ rotate: true, reason: "peak plus prompt", handoffMarkdown: "Unfinished work" }));
    const result = await execute(ctx);
    expect(result.errorFamily).toBe("target_busy");
    expect(deps.route).not.toHaveBeenCalled();
    expect(deps.tmux.mock.calls.some(([, args]) => ["kill-session", "paste-buffer", "send-keys"].includes(args[0]))).toBe(false);
    await expect(fs.stat(path.join(stateDir, "active.json"))).rejects.toThrow();
  });
  it("dispatches into the busy conversation and completes on its receipt without clearing", async () => {
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conversation-busy");
    expect(deps.route).toHaveBeenCalledOnce();
    expect(deps.deliver).toHaveBeenCalledOnce();
    expect(deps.tmux.mock.calls.some(([, args]) => ["kill-session", "paste-buffer", "send-keys"].includes(args[0]))).toBe(false);
    await expect(fs.stat(path.join(stateDir, "active.json"))).rejects.toThrow();
  });

  it("keeps the actual working folder when a busy seat's configured cwd changes", async () => {
    ctx.config.cwd = path.join(dir, "new-workspace");
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({ cwd });
    expect(deps.tmux.mock.calls.some(([, args]) => args[0] === "kill-session")).toBe(false);
  });

  it("acknowledges /clear by the changed conversation even when the next turn is busy", async () => {
    screen = `${rcUrl}\n❯ \n  bypass permissions on`;
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "display-message") return args.at(-1) === "#{pane_current_path}" ? cwd : "claude";
      if (args[0] === "send-keys" && args.at(-1) === "Enter") {
        await fs.writeFile(path.join(dir, ".claude/sessions/1.json"), JSON.stringify({
          pid: process.pid, sessionId: "conversation-cleared", cwd, tmux: "seat:@1.%1", updatedAt: 2,
        }));
        screen = busy;
      }
      return "";
    });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conversation-cleared");
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("uses the actual guarded tmux fallback while busy", async () => {
    const submit = deps.route.getMockImplementation()!;
    deps.route.mockImplementation(async (op, prompt, adopted, io) => {
      await io.fallback();
      return submit(op, prompt, adopted, io);
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(deps.tmux.mock.calls.some(([, args]) => args[0] === "paste-buffer")).toBe(true);
  });

  it("accepts a worker block terminal without waiting for an idle TUI", async () => {
    deps.route.mockImplementation(async () => {
      await fs.mkdir(path.join(stateDir, "channel-bridge"));
      await fs.writeFile(path.join(stateDir, "channel-bridge/ledger.jsonl"), JSON.stringify({
        ev: "terminal", op_id: ctx.runId, kind: "block", reason: "Required input unavailable",
      }) + "\n");
      return "channel";
    });
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({ blocked: true });
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it("re-sends a refused receipt while busy, then completes on the corrected receipt", async () => {
    deps.gate.mockResolvedValueOnce({ ok: false, reasons: ["missing commit"] });
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "capture-pane") return busy;
      if (args[0] === "display-message") return args.at(-1) === "#{pane_current_path}" ? cwd : "claude";
      if (args[0] === "send-keys" && args.at(-1) === "Enter") await deps.route();
      return "";
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    expect(deps.gate).toHaveBeenCalledTimes(2);
    expect(deps.deliver).toHaveBeenCalledOnce();
  });

  it("types native goals while busy in literal chunks, including chunks starting with a flag", async () => {
    vi.useFakeTimers();
    const command = "/goal " + "x".repeat(18) + "-1 " + "z".repeat(1400);
    const echoed = /Goal set:|\/goal active/i;
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "send-keys" && args.at(-1) === "Enter") screen = busy + "\n/goal active";
      return "";
    });
    const result = typeNativeGoal("socket", "seat", command, echoed);
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    const typed = deps.tmux.mock.calls.map(([, args]) => args as string[]).filter(args => args.includes("-l"));
    expect(typed.map(args => args.at(-1)).join("")).toBe(command);
    expect(typed.every(args => args.at(-2) === "--" && Array.from(args.at(-1)!).length <= 24)).toBe(true);
    expect(typed[1].at(-1)).toMatch(/^-1/);
  });

  it("leaves owner input intact for a native goal", async () => {
    screen = "✻ Thinking…\n❯ owner is typing\n  bypass permissions on";
    expect(await typeNativeGoal("socket", "seat", "/goal finish", /Goal set:/)).toBe(false);
    expect(deps.tmux).toHaveBeenCalledTimes(1);
  });

  it("applies a managed runner-goal edit to the busy seat before dispatch", async () => {
    ctx.context.paperclipRunnerGoal = { state: "active", objective: "Finish the busy wake", key: "active:edited" };
    deps.tmux.mockImplementation(async (_socket: string, args: string[]) => {
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "display-message") return args.at(-1) === "#{pane_current_path}" ? cwd : "claude";
      if (args[0] === "send-keys" && args.at(-1) === "Enter") screen = busy + "\nGoal set: Finish the busy wake";
      return "";
    });
    expect((await execute(ctx)).exitCode).toBe(0);
    const seat = JSON.parse(await fs.readFile(path.join(stateDir, "seat.json"), "utf8"));
    expect(seat.nativeGoalKey).toBe("active:edited");
    const typed = deps.tmux.mock.calls.map(([, args]) => args as string[]).filter(args => args.includes("-l"));
    expect(typed.map(args => args.at(-1)).join("")).toBe("/goal Finish the busy wake");
  });
});
