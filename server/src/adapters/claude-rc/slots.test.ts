import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimSlot, rcSlot, rcSlotCount, RC_MAX_SLOTS } from "./execute.js";
import { deriveRcName, RC_NAME_MAX, slotRcName } from "./rc-name.js";

const runId = "11111111-1111-4111-8111-111111111111";
const ctx = { runId, context: { issueId: "i2" }, agent: { id: "a" }, onLog: async () => {} } as never;

describe("claude_rc_local concurrent seats (SCO-965)", () => {
  it("clamps slot count", () => {
    expect(rcSlotCount(undefined)).toBe(1);
    expect(rcSlotCount(0)).toBe(1);
    expect(rcSlotCount(2)).toBe(2);
    expect(rcSlotCount(99)).toBe(RC_MAX_SLOTS);
  });

  it("keeps seat 1 as configured and isolates later seats", () => {
    expect(rcSlot(0, "claude", "/s")).toEqual({ index: 0, session: "claude", stateDir: "/s" });
    expect(rcSlot(1, "claude", "/s")).toEqual({ index: 1, session: "claude-s1", stateDir: "/s/s1" });
  });

  it("names later seats' Remote Control sessions with the slot, within the cap", () => {
    expect(deriveRcName("Claude Sonnet", 1)).toBe("1 Claude Sonnet");
    expect(deriveRcName("Claude Sonnet", 1, 2)).toBe("1 Claude Sonnet s2");
    const long = slotRcName("x".repeat(RC_NAME_MAX), 3);
    expect(long.length).toBeLessThanOrEqual(RC_NAME_MAX);
    expect(long.endsWith(" s3")).toBe(true);
  });

  it("two runs take two seats; a held or checkpointed seat is skipped; the issue's own seat is adopted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rc-slots-"));
    try {
      const slots = [0, 1].map(i => rcSlot(i, "claude", root));
      const a = await claimSlot(ctx, slots, "i1", Date.now() + 2000);
      const b = await claimSlot(ctx, slots, "i2", Date.now() + 2000);
      expect([a.slot.index, b.slot.index]).toEqual([0, 1]);
      await expect(claimSlot(ctx, slots, "i3", Date.now() + 1200)).rejects.toThrow(/previous task unresolved/);
      await a.unlock(); await b.unlock();
      // Seat 0 now holds an unresolved checkpoint for another issue; seat 1 is free.
      await writeFile(path.join(root, "active.json"), JSON.stringify({ issueId: "i1" }));
      const c = await claimSlot(ctx, slots, "i3", Date.now() + 2000);
      expect(c.slot.index).toBe(1);
      await c.unlock();
      // Same issue returns to its own checkpointed seat.
      await writeFile(path.join(root, "active.json"), JSON.stringify({ runId, issueId: "i1",
        receiptPath: path.join(root, `receipt-${runId}.json`), rcUrl: "https://claude.ai/code/test" }));
      const ownCtx = { runId, context: { issueId: "i1" }, agent: { id: "a" }, onLog: async () => {} } as never;
      const d = await claimSlot(ownCtx, slots, "i1", Date.now() + 2000);
      expect(d.slot.index).toBe(0);
      await d.unlock();
      // Every seat checkpointed by other issues: target_busy-shaped refusal, not a wait.
      await writeFile(path.join(root, "active.json"), JSON.stringify({ issueId: "i1" }));
      await writeFile(path.join(root, "s1", "active.json"), JSON.stringify({ issueId: "i9" }));
      await expect(claimSlot(ctx, slots, "i3", Date.now() + 2000)).rejects.toThrow(/previous task unresolved/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
