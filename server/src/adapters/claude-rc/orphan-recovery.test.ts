import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { reconcileOrphanActive, recordDispatchMode } from "./execute.js";
import { findBridgeRoot, prepareChannelHost, routeChannelInput } from "./channel.js";
import { adoptableActive } from "../agy/execute.js";

const dirs: string[] = [];
const op = "12345678-1234-1234-1234-123456789abc";
async function fixture(mode = "prepared") {
  const dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco980-");
  dirs.push(dir);
  const activePath = path.join(dir, "active.json");
  const active = { runId: op, op_id: op, issueId: "original", dispatchMode: mode,
    receiptPath: path.join(dir, `receipt-${op}.json`), rcUrl: "https://claude.ai/code/session_test",
    startedAt: new Date(Date.now() - 600_000).toISOString() };
  await fs.writeFile(activePath, JSON.stringify(active));
  const root = await findBridgeRoot();
  const host = await prepareChannelHost(dir, root);
  return { dir, activePath, active, root, host,
    options: { stateDir: dir, activePath, issueId: "original", runId: "next",
      live: async () => false, paneIdle: async () => true, status: host.status, log: () => {} } };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("SCO-980 orphan effect reconciliation", () => {
  it("preserves a real emitted bridge operation across repeated same/foreign issue wakes", async () => {
    const f = await fixture("channel-pending");
    const { Ledger, processInbox } = createRequire(import.meta.url)(path.join(f.root, "lib/bridge.cjs"));
    await f.host.submit(op, "isolated fixture work");
    let effects = 0;
    await processInbox(new Ledger(f.host.dir), async () => { effects++; });
    expect(await f.host.status(op)).toMatchObject({ stage: "emitted_local" });
    const original = await fs.readFile(f.activePath, "utf8");
    for (const [i, issueId] of ["original", "foreign", "original", "foreign"].entries()) {
      // Fresh host simulates process-local state loss; durable files remain.
      const restarted = await prepareChannelHost(f.dir, f.root);
      expect(await reconcileOrphanActive({ ...f.options, status: restarted.status,
        issueId, runId: `wake-${i}` })).toBe("kept");
      expect(await fs.readFile(f.activePath, "utf8")).toBe(original);
      if (issueId === "foreign") {
        expect(() => adoptableActive(original, issueId, f.dir, "claude_rc_local")).toThrow(/Never replay/);
      } else {
        const adopted = adoptableActive(original, issueId, f.dir, "claude_rc_local");
        expect(await routeChannelInput(op, "", Boolean(adopted), {
          ...restarted, fallback: async () => { throw new Error("no fallback"); },
        })).toBe("adopted");
      }
      await processInbox(new Ledger(f.host.dir), async () => { effects++; });
    }
    expect(effects).toBe(1);
  });

  it.each(["channel-pending", "tmux-fallback", "legacy"])("keeps %s even with an empty bridge", async mode => {
    const f = await fixture(mode);
    for (let i = 0; i < 4; i++) {
      expect(await reconcileOrphanActive({ ...f.options, runId: `wake-${i}` })).toBe("kept");
    }
  });

  it("recovers definitely never-submitted checkpoints, preserving their records", async () => {
    const f = await fixture();
    expect(await f.host.status(op)).toBeNull();
    expect(await reconcileOrphanActive(f.options)).toBe("archived");
    expect(JSON.parse(await fs.readFile(path.join(f.dir, `active.never-submitted-${op}.json`), "utf8"))).toEqual(f.active);
    await expect(fs.stat(f.activePath)).rejects.toThrow();
  });

  it("keeps prepared checkpoints when inbox evidence, lookup failure, live work or a receipt exists", async () => {
    const f = await fixture();
    expect(await reconcileOrphanActive({ ...f.options, live: async () => true })).toBe("kept");
    expect(await reconcileOrphanActive({ ...f.options, paneIdle: async () => false })).toBe("kept");
    expect(await reconcileOrphanActive({ ...f.options, status: async () => { throw new Error("unavailable"); } })).toBe("kept");
    await f.host.submit(op, "queued");
    expect(await reconcileOrphanActive(f.options)).toBe("kept");
    await fs.writeFile(f.active.receiptPath, "{}");
    expect(await reconcileOrphanActive(f.options)).toBe("none");
  });

  it.each(["channel-pending", "tmux-fallback"] as const)("retains a crash after durable %s intent but before transport", async mode => {
    const f = await fixture();
    await recordDispatchMode(f.activePath, f.active, mode);
    expect(JSON.parse(await fs.readFile(f.activePath, "utf8")).dispatchMode).toBe(mode);
    expect(await f.host.status(op)).toBeNull();
    expect(await reconcileOrphanActive(f.options)).toBe("kept");
  });
});
