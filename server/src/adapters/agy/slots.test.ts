import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { agySlot, agySlotCount, agySlotCountForAgent, target, tmux, tryAcquire, AGY_MAX_SLOTS } from "./execute.js";

describe("agy concurrent seats (SCO-991)", () => {
  it("gives more than one seat only to Gemini tiers", () => {
    expect(agySlotCount(2, "gemini-3.8-flash-medium")).toBe(2);
    expect(agySlotCount(3, "gemini-4-argon-high")).toBe(3);
    expect(agySlotCount(4, "claude-opus-5-5-high")).toBe(1);
    expect(agySlotCount(2, "claude-sonnet-5-5-medium")).toBe(1);
    expect(agySlotCount(undefined, "gemini-3.8-flash-low")).toBe(1);
    expect(agySlotCount(12, "gemini-3.8-flash-low")).toBe(12);
    expect(agySlotCount(99, "gemini-3.8-flash-low")).toBe(AGY_MAX_SLOTS);
    expect(agySlotCount(0, "gemini-3.8-flash-low")).toBe(1);
  });

  it("uses the heartbeat policy for the seat count", () => {
    const agent = { id: "agent", companyId: "company", name: "agy", adapterType: "agy_local",
      adapterConfig: { slots: 1 }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } };
    expect(agySlotCountForAgent(agent, "gemini-4-argon-high")).toBe(3);
    expect(agySlotCountForAgent(agent, "claude-opus-5-5-high")).toBe(1);
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

  it("targets the exact seat even when a later seat has a window named like seat 1", async () => {
    const socket = `agy-slot-test-${process.pid}`;
    const run = (...a: string[]) => execFileSync("/opt/homebrew/bin/tmux", ["-L", socket, ...a]);
    try {
      run("new-session", "-d", "-s", "agy", "-n", "agy", "sleep", "60");
      run("new-session", "-d", "-s", "agy-s1", "-n", "agy", "sleep", "60");
      expect((await tmux(socket, ["display-message", "-p", ...target("agy"), "#{session_name}"])).trim()).toBe("agy");
      expect((await tmux(socket, ["display-message", "-p", ...target("agy-s1"), "#{session_name}"])).trim()).toBe("agy-s1");
      await expect(tmux(socket, ["has-session", ...target("agy-s")])).rejects.toThrow();
    } finally { try { run("kill-server"); } catch { /* already gone */ } }
  });
});
