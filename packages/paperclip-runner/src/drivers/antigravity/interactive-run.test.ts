import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AntigravityInteractiveRun, type AntigravityInteractiveCheckpoint } from "./interactive-run.js";
import type { AntigravityInteractiveControl } from "./interactive-control.js";

const scratch = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const binding = { runId: "run-1", issueId: "SCO-1104" };

function checkpoint(overrides: Partial<AntigravityInteractiveCheckpoint> = {}): AntigravityInteractiveCheckpoint {
  return { runId: "run-1", issueId: "SCO-1104", receiptPath: "/Volumes/NVM/AI_Agent_Runtime/tmp/receipt.json",
    rcUrl: "https://antigravity.google.com/r/seat-1", tmuxSocket: "socket", tmuxSession: "seat",
    conversationId: "conversation-1", startedAt: "2026-11-05T12:00:00.000Z", paneId: "%42", panePid: "123", ...overrides };
}

async function writeActive(stateDir: string, record: unknown): Promise<void> {
  await writeFile(path.join(stateDir, "active.json"), JSON.stringify(record), { mode: 0o600 });
}

function makeControl() {
  const submit = vi.fn(async (_operationId: string, _message: string, _runId: string) =>
    ({ disposition: "written_consumption_unknown" as const }));
  const interruptRun = vi.fn(async (_runId: string, _options?: { timeoutMs?: number })
    : Promise<"idle" | "restart_required"> => "idle");
  return { control: { submit, interruptRun } as Pick<AntigravityInteractiveControl, "submit" | "interruptRun">, submit, interruptRun };
}

describe("Antigravity interactive run checkpoint", () => {
  it("persists the exact checkpoint record, fsynced, before the control submit and preserves pane identity", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, submit } = makeControl();
    const atSubmit: string[] = [];
    const operations: string[] = [];
    const open = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await sync();
        operations.push(args[0] === stateDir ? "directory synced" : "file synced");
      });
      return handle;
    });
    submit.mockImplementation(async () => {
      operations.push("submit");
      atSubmit.push(await readFile(path.join(stateDir, "active.json"), "utf8"));
      return { disposition: "written_consumption_unknown" as const };
    });
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      const record = checkpoint();
      await run.dispatch(record, "work on this issue");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith("run-1", "work on this issue", "run-1");
      expect(atSubmit).toHaveLength(1);
      expect(atSubmit[0]).toBe(JSON.stringify(record));
      expect(operations).toEqual(["file synced", "directory synced", "submit"]);
      expect((await lstat(path.join(stateDir, "active.json"))).mode & 0o777).toBe(0o600);
    } finally {
      openSpy.mockRestore();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adopts an existing exact run+issue checkpoint and dispatches nothing", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, submit } = makeControl();
    const existing = checkpoint({ conversationId: null });
    try {
      await writeActive(stateDir, existing);
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await expect(run.dispatch(checkpoint(), "retry the turn")).rejects.toThrow(/replay/);
      expect(submit).not.toHaveBeenCalled();
      expect(await readFile(path.join(stateDir, "active.json"), "utf8")).toBe(JSON.stringify(existing));
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("refuses a checkpoint owned by another run or issue and a missing identity", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control } = makeControl();
    try {
      await writeActive(stateDir, checkpoint({ runId: "other" }));
      await expect(AntigravityInteractiveRun.open({ stateDir, ...binding, control })).rejects.toThrow(/ownership/);
      await writeActive(stateDir, checkpoint({ issueId: "other" }));
      await expect(AntigravityInteractiveRun.open({ stateDir, ...binding, control })).rejects.toThrow(/ownership/);
      await expect(AntigravityInteractiveRun.open({ stateDir, runId: "", issueId: "SCO-1104", control }))
        .rejects.toThrow(/identity missing/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("refuses dispatch for a changed owner without touching the seat", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, submit } = makeControl();
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await expect(run.dispatch(checkpoint({ runId: "run-2" }), "work")).rejects.toThrow(/replay|ownership/);
      await expect(run.dispatch(checkpoint({ issueId: "SCO-999" }), "work")).rejects.toThrow(/replay|ownership/);
      expect(submit).not.toHaveBeenCalled();
      await expect(readFile(path.join(stateDir, "active.json"))).rejects.toThrow(/ENOENT/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("retains an uncertain submit and never replays it", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, submit } = makeControl();
    submit.mockRejectedValue(new Error("connection lost"));
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      const record = checkpoint();
      await expect(run.dispatch(record, "work")).rejects.toThrow(/connection lost/);
      expect(await readFile(path.join(stateDir, "active.json"), "utf8")).toBe(JSON.stringify(record));
      await expect(run.dispatch(record, "work")).rejects.toThrow(/replay/);
      expect(submit).toHaveBeenCalledTimes(1);
      await run.complete();
      await expect(readFile(path.join(stateDir, "active.json"))).rejects.toThrow(/ENOENT/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("complete retires only the owned checkpoint", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control } = makeControl();
    const active = path.join(stateDir, "active.json");
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await run.dispatch(checkpoint(), "work");
      await writeActive(stateDir, checkpoint({ runId: "run-2" }));
      await expect(run.complete()).rejects.toThrow(/ownership/);
      expect(await readFile(active, "utf8")).toBe(JSON.stringify(checkpoint({ runId: "run-2" })));
      await writeActive(stateDir, checkpoint());
      await run.complete();
      await expect(readFile(active)).rejects.toThrow(/ENOENT/);
      await expect(run.complete()).rejects.toThrow(/missing/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("stop interrupts only the exact run and archives the checkpoint on verified idle", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, interruptRun } = makeControl();
    const record = checkpoint();
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await run.dispatch(record, "work");
      expect(await run.stop()).toBe("idle");
      expect(interruptRun).toHaveBeenCalledTimes(1);
      expect(interruptRun).toHaveBeenCalledWith("run-1", {});
      const entries = (await readdir(stateDir)).sort();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.startsWith("active.settled-")).toBe(true);
      expect(JSON.parse(await readFile(path.join(stateDir, entries[0]!), "utf8"))).toEqual(record);
      await expect(run.stop()).rejects.toThrow(/missing before Stop/);
      await expect(run.dispatch(record, "again")).rejects.toThrow(/replay/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("stop retains the checkpoint when the seat requires a restart", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, interruptRun } = makeControl();
    interruptRun.mockResolvedValue("restart_required" as const);
    const record = checkpoint();
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await run.dispatch(record, "work");
      expect(await run.stop()).toBe("restart_required");
      expect(await readFile(path.join(stateDir, "active.json"), "utf8")).toBe(JSON.stringify(record));
      expect((await readdir(stateDir)).filter(name => name.startsWith("active.settled-"))).toEqual([]);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("stop without a checkpoint does nothing", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, interruptRun } = makeControl();
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      expect(await run.stop()).toBe("idle");
      expect(interruptRun).not.toHaveBeenCalled();
      expect(await readdir(stateDir)).toEqual([]);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("stop refuses a checkpoint whose owner changed and fails closed when it disappears", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const { control, interruptRun } = makeControl();
    const active = path.join(stateDir, "active.json");
    try {
      const run = await AntigravityInteractiveRun.open({ stateDir, ...binding, control });
      await run.dispatch(checkpoint(), "work");
      await writeActive(stateDir, checkpoint({ runId: "run-2" }));
      await expect(run.stop()).rejects.toThrow(/ownership/);
      expect(interruptRun).not.toHaveBeenCalled();
      expect(await readFile(active, "utf8")).toBe(JSON.stringify(checkpoint({ runId: "run-2" })));
      await rm(active);
      await expect(run.stop()).rejects.toThrow(/missing before Stop/);
      expect(interruptRun).not.toHaveBeenCalled();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("archiveSettled retires only an exact run+issue checkpoint", async () => {
    const stateDir = await mkdtemp(path.join(scratch, "agy-run-"));
    const active = path.join(stateDir, "active.json");
    const record = checkpoint();
    try {
      await writeActive(stateDir, record);
      await AntigravityInteractiveRun.archiveSettled({ stateDir, ...binding });
      const entries = await readdir(stateDir);
      expect(entries.filter(name => name === "active.json")).toEqual([]);
      const settled = entries.filter(name => name.startsWith("active.settled-"));
      expect(settled).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(stateDir, settled[0]!), "utf8"))).toEqual(record);
      await writeActive(stateDir, record);
      await expect(AntigravityInteractiveRun.archiveSettled({ stateDir, runId: "run-2", issueId: "SCO-1104" }))
        .rejects.toThrow(/ownership/);
      await expect(AntigravityInteractiveRun.archiveSettled({ stateDir, runId: "run-1", issueId: "SCO-999" }))
        .rejects.toThrow(/ownership/);
      expect(await readFile(active, "utf8")).toBe(JSON.stringify(record));
      await rm(active);
      await expect(AntigravityInteractiveRun.archiveSettled({ stateDir, ...binding })).rejects.toThrow(/missing/);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  it("requires a private owned directory and record", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-run-"));
    const stateDir = path.join(root, "state");
    const link = path.join(root, "link");
    const foreign = path.join(root, "foreign.json");
    const active = path.join(stateDir, "active.json");
    const { control } = makeControl();
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await symlink(stateDir, link);
      await expect(AntigravityInteractiveRun.open({ stateDir: "relative", ...binding, control }))
        .rejects.toThrow(/absolute/);
      await expect(AntigravityInteractiveRun.open({ stateDir: link, ...binding, control })).rejects.toThrow(/private/);
      await chmod(stateDir, 0o755);
      await expect(AntigravityInteractiveRun.open({ stateDir, ...binding, control })).rejects.toThrow(/private/);
      await chmod(stateDir, 0o700);
      await writeFile(foreign, JSON.stringify(checkpoint()));
      await symlink(foreign, active);
      await expect(AntigravityInteractiveRun.open({ stateDir, ...binding, control })).rejects.toThrow(/private/);
      await rm(active);
      await writeFile(active, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
      await expect(AntigravityInteractiveRun.open({ stateDir, ...binding, control })).rejects.toThrow(/private/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
