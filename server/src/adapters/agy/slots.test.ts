import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agySlot, agySlotCount, tryAcquire, AGY_MAX_SLOTS } from "./execute.js";

describe("agy concurrent seats (SCO-991)", () => {
  it("gives more than one seat only to Gemini tiers", () => {
    expect(agySlotCount(2, "gemini-3.8-flash-medium")).toBe(2);
    expect(agySlotCount(3, "gemini-4-argon-high")).toBe(3);
    expect(agySlotCount(4, "claude-opus-5-5-high")).toBe(1);
    expect(agySlotCount(2, "claude-sonnet-5-5-medium")).toBe(1);
    expect(agySlotCount(undefined, "gemini-3.8-flash-low")).toBe(1);
    expect(agySlotCount(99, "gemini-3.8-flash-low")).toBe(AGY_MAX_SLOTS);
    expect(agySlotCount(0, "gemini-3.8-flash-low")).toBe(1);
  });

  it("keeps seat 1 as configured and isolates later seats", () => {
    expect(agySlot(0, "pc-agy-medium", "agy", "/s/agy-medium", "/Volumes/NVM"))
      .toEqual({ index: 0, session: "agy", stateDir: "/s/agy-medium", cwd: "/Volumes/NVM" });
    expect(agySlot(1, "pc-agy-medium", "agy", "/s/agy-medium", "/Volumes/NVM"))
      .toEqual({ index: 1, session: "agy-s1", stateDir: "/s/agy-medium/s1",
        cwd: "/Volumes/NVM/AI_Agent_Runtime/workspaces/pc-agy-medium-s1" });
  });

  it("lets two runs hold two seats but never one seat twice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-slots-"));
    try {
      const a = await tryAcquire(root);
      expect(a).not.toBeNull();
      expect(await tryAcquire(root)).toBeNull();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "s1"));
      const b = await tryAcquire(path.join(root, "s1"));
      expect(b).not.toBeNull();
      await a!(); await b!();
      expect(await tryAcquire(root)).not.toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
