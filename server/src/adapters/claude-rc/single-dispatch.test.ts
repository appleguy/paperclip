import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Checkpoint reconciliation may inspect a pane. Never touch a live owner TUI.
const transport = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: transport.exec,
}));
import { claimSlot as rcClaim, rcSlot } from "./execute.js";
import { claimSlot as agyClaim, agySlot, tryAcquire, receiptFilePath, isTargetBusyRefusal } from "../agy/execute.js";

const oldRun = "11111111-1111-4111-8111-111111111111";
const currentRun = "22222222-2222-4222-8222-222222222222";
let dir: string;
let api: ReturnType<typeof vi.fn>;
const ctx = () => ({ agent: { id: "agent", companyId: "company" }, runId: currentRun,
  authToken: "test-token", config: { tmuxSocket: "test-socket" },
  context: { issueId: "new" }, onLog: vi.fn() }) as unknown as AdapterExecutionContext;
const receipt = { runId: oldRun, issueId: "old", status: "done", summary: "Finished assigned work", report: "Verified completion evidence. ".repeat(12) };
const checkpoint = () => ({ runId: oldRun, issueId: "old", rcUrl: "https://example.test/rc", receiptPath: receiptFilePath(dir, oldRun) });
const run = (status: string, extra = {}) => ({ id: oldRun, agentId: "agent", companyId: "company", status, contextSnapshot: { issueId: "old" }, ...extra });
beforeEach(async () => {
  dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/single-dispatch-");
  api = vi.fn(async () => Response.json(run("running")));
  vi.stubGlobal("fetch", api);
  transport.exec.mockImplementation((_command, _args, _options, callback) => callback(null, { stdout: "Working...", stderr: "" }));
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }); });

for (const adapter of ["rc", "agy"]) describe(`${adapter} single dispatch`, () => {
  const claim = (context = ctx()) => adapter === "rc"
    ? rcClaim(context, [rcSlot(0, "seat", dir)], "new", Date.now() + 1000)
    : agyClaim(context, [agySlot(0, "socket", "seat", dir, dir)], "new", Date.now() + 1000);
  it("coalesces a held seat immediately, without a run lookup", async () => {
    const release = await tryAcquire(dir);
    try {
      await expect(claim()).rejects.toThrow(/seat busy/);
      expect(api).not.toHaveBeenCalled();
    } finally { await release!(); }
  });
  it("honors cancellation before lookup or reconciliation", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(checkpoint()));
    const context = ctx(); context.signal = AbortSignal.abort();
    await expect(claim(context)).rejects.toThrow(/cancelled/);
    expect(api).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(oldRun);
  });
  it.each(["old", "new"])("retains a live checkpoint for issue %s without settlement", async issueId => {
    const active = { ...checkpoint(), issueId };
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(active));
    api.mockResolvedValue(Response.json(run("running", { contextSnapshot: { issueId } })));
    await expect(claim()).rejects.toThrow(/seat busy/);
    expect(JSON.parse(await fs.readFile(path.join(dir, "active.json"), "utf8"))).toEqual(active);
    expect(api).toHaveBeenCalledOnce();
    const unlock = await tryAcquire(dir);
    expect(unlock).not.toBeNull();
    await unlock!();
  });
  it.each(["unavailable", "wrong-agent", "wrong-company", "wrong-issue", "wrong-run"])("retains uncertain %s run evidence", async kind => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(checkpoint()));
    api.mockImplementation(async () => {
      if (kind === "unavailable") throw new Error("offline");
      return Response.json(run("succeeded", {
        ...(kind === "wrong-agent" ? { agentId: "other" } : {}),
        ...(kind === "wrong-company" ? { companyId: "other" } : {}),
        ...(kind === "wrong-issue" ? { contextSnapshot: { issueId: "other" } } : {}),
        ...(kind === "wrong-run" ? { id: currentRun } : {}),
      }));
    });
    await expect(claim()).rejects.toThrow(/seat busy/);
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(oldRun);
  });
  it("archives a terminal checkpoint only after verified receipt delivery", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(checkpoint()));
    await fs.writeFile(receiptFilePath(dir, oldRun), JSON.stringify(receipt));
    if (adapter === "rc") {
      const outcome = { kind: "done", receipt };
      await fs.writeFile(path.join(dir, `settled-${oldRun}.json`), JSON.stringify({ version: 1,
        agentId: "agent", runId: oldRun, issueId: "old", outcome,
        fingerprint: createHash("sha256").update(JSON.stringify(outcome)).digest("hex"), status: "done", reportRevisionId: "rev" }));
    }
    api.mockImplementation(async (url: string) => Response.json(String(url).includes("heartbeat-runs")
      ? run("succeeded") : String(url).endsWith("/documents/report") ? { body: receipt.report, latestRevisionId: "rev" } : { status: "done" }));
    const held = await claim();
    try {
      await expect(fs.stat(path.join(dir, "active.json"))).rejects.toThrow();
      expect((await fs.readdir(dir)).some(name => name.startsWith("active."))).toBe(true);
      expect(api.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
    } finally { await held.unlock(); }
  });
  it("keeps a receiptless terminal checkpoint while the provider remains busy", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify(checkpoint()));
    api.mockImplementation(async () => Response.json(run("failed")));
    await expect(claim()).rejects.toThrow(/seat busy/);
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(oldRun);
  });
  it.each(["old", "new"])("keeps issue affinity while selecting among multiple seats (%s)", async issueId => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({ ...checkpoint(), issueId }));
    api.mockImplementation(async () => Response.json(run("running", { contextSnapshot: { issueId } })));
    const attempt = adapter === "rc"
      ? rcClaim(ctx(), [rcSlot(0, "seat", dir), rcSlot(1, "seat", dir)], "new", Date.now() + 1000)
      : agyClaim(ctx(), [agySlot(0, "socket", "seat", dir, dir), agySlot(1, "socket", "seat", dir, dir)], "new", Date.now() + 1000);
    if (issueId === "new") await expect(attempt).rejects.toThrow(/seat busy/);
    else { const held = await attempt; expect(held.slot.index).toBe(1); await held.unlock(); }
    expect(await fs.readFile(path.join(dir, "active.json"), "utf8")).toContain(oldRun);
  });
  it("reattaches only the exact restart run and never queries itself", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({ ...checkpoint(), runId: currentRun,
      issueId: "new", receiptPath: receiptFilePath(dir, currentRun) }));
    const context = ctx(); context.context.paperclipRestartReattach = true;
    const held = await claim(context); await held.unlock();
    expect(api).not.toHaveBeenCalled();
  });
  it("refuses restart adoption of a different run", async () => {
    await fs.writeFile(path.join(dir, "active.json"), JSON.stringify({ ...checkpoint(), issueId: "new" }));
    const context = ctx(); context.context.paperclipRestartReattach = true;
    await expect(claim(context)).rejects.toThrow(/restart checkpoint run mismatch/);
  });
});
it("classifies all serialization refusals as coalesced waits", () => {
  for (const reason of ["agy single Remote Control session busy: serialization timeout", "claude_rc_local Remote Control seats busy: serialization timeout"])
    expect(isTargetBusyRefusal(reason)).toBe(true);
  expect(isTargetBusyRefusal("invalid tmux socket/session")).toBe(false);
});
