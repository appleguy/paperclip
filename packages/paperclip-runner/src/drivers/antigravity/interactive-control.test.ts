import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AntigravityInteractiveControl, emptyAgyEditor } from "./interactive-control.js";

const scratch = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const screen = ["https://antigravity.google.com/r/seat-1", "────────────", ">", "────────────"].join("\n");

describe("Antigravity interactive seat", () => {
  it("creates a missing seat with literal arguments, but never replaces an active seat on reattach", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-interactive-"));
    const calls: string[][] = [];
    let exists = false;
    const tmux = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "has-session" && !exists) throw new Error("no session");
      if (args[0] === "new-session") { exists = true; return ""; }
      if (args[0] === "display-message") return "%42 123 agy";
      if (args[0] === "capture-pane") return screen;
      return "";
    };
    const options = { socket: "socket", session: "seat", stateDir: path.join(root, "state"),
      cwd: path.join(root, "workspace"), tmpDir: path.join(root, "tmp"), executable: "/opt/homebrew/bin/agy",
      model: "gemini-4-argon-high", authorize: () => true, tmux };
    try {
      await expect(AntigravityInteractiveControl.open({ ...options, rejoinOnly: true })).rejects.toThrow(/reconcile/);
      expect(calls.some(args => args[0] === "new-session")).toBe(false);
      const control = await AntigravityInteractiveControl.open({ ...options, rejoinOnly: false });
      expect(control.remoteControlUrl).toBe("https://antigravity.google.com/r/seat-1");
      expect(calls.find(args => args[0] === "new-session")).toEqual(["new-session", "-d", "-s", "seat", "-c", options.cwd,
        "-e", `TMPDIR=${options.tmpDir}`, options.executable, "--remote-control", "--dangerously-skip-permissions", "--model", options.model]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds an exact pane, journals before pasting and refuses replay", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-interactive-"));
    const calls: string[][] = [];
    let input = "";
    const tmux = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "display-message") return "%42 123 agy\n";
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "load-buffer") {
        expect((await readdir(stateDir)).some(name => name.endsWith(".reservation"))).toBe(true);
        input = await readFile(args[3]!, "utf8");
      }
      return "";
    };
    try {
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir,
        expectedRemoteControlUrl: "https://antigravity.google.com/r/seat-1", authorize: () => true, tmux });
      expect(control.remoteControlUrl).toBe("https://antigravity.google.com/r/seat-1");
      await expect(control.submit("turn-1", "work on this issue")).resolves.toEqual({ disposition: "written_consumption_unknown" });
      expect(input).toBe("work on this issue");
      expect(calls.find(args => args[0] === "send-keys")).toEqual(["send-keys", "-t", "%42", "Enter"]);
      await expect(control.submit("turn-1", "work on this issue")).rejects.toThrow();
      expect((await readdir(stateDir)).filter(name => name.startsWith("input-"))).toHaveLength(0);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("refuses a changed seat, owner draft, wrong URL and revoked admission", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-interactive-"));
    let pane = "%42 123 agy", content = screen;
    const authorize = vi.fn(() => true);
    const tmux = async (args: string[]) => args[0] === "display-message" ? pane : args[0] === "capture-pane" ? content : "";
    try {
      await expect(AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir,
        expectedRemoteControlUrl: "https://antigravity.google.com/r/wrong", authorize, tmux })).rejects.toThrow(/identity/);
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, authorize, tmux });
      pane = "%43 456 agy";
      await expect(control.submit("one", "work")).rejects.toThrow(/identity changed/);
      pane = "%42 123 agy";
      content = screen.replace(">", "> draft");
      await expect(control.submit("two", "work")).rejects.toThrow(/input guard/);
      content = screen;
      authorize.mockReturnValue(false);
      await expect(control.submit("three", "work")).rejects.toThrow(/denied/);
      expect(await readdir(stateDir)).toHaveLength(0);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("keeps the reservation when a paste outcome is uncertain", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-interactive-"));
    const tmux = async (args: string[]) => {
      if (args[0] === "display-message") return "%42 123 agy";
      if (args[0] === "capture-pane") return screen;
      if (args[0] === "paste-buffer") throw new Error("connection lost");
      return "";
    };
    try {
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, authorize: () => true, tmux });
      await expect(control.submit("uncertain", "work")).rejects.toThrow(/connection lost/);
      expect((await readdir(stateDir)).filter(name => name.endsWith(".reservation"))).toHaveLength(1);
      await expect(control.submit("uncertain", "work")).rejects.toThrow();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("interrupts only the checkpointed pane, escalating if it stays busy", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-interactive-"));
    const calls: string[][] = [];
    let clock = 0;
    const tmux = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "display-message") return "%42 123 agy";
      if (args[0] === "capture-pane") return screen;
      return "";
    };
    try {
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-1" }));
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, authorize: () => true, tmux });
      await expect(control.interruptRun("other", { isIdle: async () => false })).rejects.toThrow(/ownership/);
      expect(calls.filter(args => args[0] === "send-keys")).toEqual([]);
      const result = await control.interruptRun("run-1", { isIdle: async () => clock >= 6000, now: () => clock,
        wait: async ms => { clock += ms; }, timeoutMs: 10_000 });
      expect(result).toBe("idle");
      expect(calls.filter(args => args[0] === "send-keys")).toEqual([
        ["send-keys", "-t", "%42", "Escape"], ["send-keys", "-t", "%42", "C-c"],
      ]);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("returns restart required at the deadline and refuses a changed checkpoint", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-interactive-"));
    let clock = 0;
    const tmux = async (args: string[]) => args[0] === "display-message" ? "%42 123 agy" : args[0] === "capture-pane" ? screen : "";
    try {
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-1" }));
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, authorize: () => true, tmux });
      expect(await control.interruptRun("run-1", { isIdle: async () => false, now: () => clock,
        wait: async ms => { clock += ms; }, timeoutMs: 1000 })).toBe("restart_required");
      await expect(control.interruptRun("run-1", { isIdle: async () => {
        await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-2" }));
        return false;
      }, now: () => clock, wait: async ms => { clock += ms; }, timeoutMs: 1000 })).rejects.toThrow(/ownership/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("restarts only the owned session and resumes its conversation", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-interactive-"));
    const stateDir = path.join(root, "state");
    const calls: string[][] = [];
    let exists = true;
    const tmux = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "has-session" && !exists) throw new Error("no session");
      if (args[0] === "kill-session") exists = false;
      if (args[0] === "new-session") exists = true;
      if (args[0] === "display-message") return "%42 123 agy";
      if (args[0] === "capture-pane") return screen;
      return "";
    };
    const launch = { cwd: path.join(root, "workspace"), tmpDir: path.join(root, "tmp"),
      executable: "/opt/homebrew/bin/agy", model: "gemini-4-argon-high", conversationId: "conversation-1" };
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(path.join(stateDir, "active.json"), JSON.stringify({ runId: "run-1", conversationId: "conversation-1" }));
      const control = await AntigravityInteractiveControl.attach({ socket: "socket", session: "seat", stateDir, authorize: () => true, tmux });
      await expect(control.restartRunSeat("run-2", launch)).rejects.toThrow(/ownership/);
      await expect(control.restartRunSeat("run-1", { ...launch, conversationId: "--bad" })).rejects.toThrow(/Invalid/);
      await expect(control.restartRunSeat("run-1", launch)).rejects.toThrow(/interrupt timeout/);
      let clock = 0;
      expect(await control.interruptRun("run-1", { isIdle: async () => false, now: () => clock,
        wait: async ms => { clock += ms; }, timeoutMs: 1000 })).toBe("restart_required");
      await expect(control.restartRunSeat("run-1", { ...launch, conversationId: "other" })).rejects.toThrow(/conversation/);
      expect(calls.some(args => args[0] === "kill-session")).toBe(false);
      const relaunched = await control.restartRunSeat("run-1", launch);
      expect(relaunched.remoteControlUrl).toBe("https://antigravity.google.com/r/seat-1");
      expect(calls.find(args => args[0] === "kill-session")).toEqual(["kill-session", "-t", "=seat:"]);
      expect(calls.find(args => args[0] === "new-session")?.slice(-2)).toEqual(["--conversation", "conversation-1"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recognizes only an empty current editor", () => {
    expect(emptyAgyEditor(screen)).toBe(true);
    expect(emptyAgyEditor(screen.replace(">", "> owner text"))).toBe(false);
    expect(emptyAgyEditor("Generating..." )).toBe(false);
  });
});
