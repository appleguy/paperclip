import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimAgyHostAdmission, isAgyAdmissionIdle, isAgyHostLimitedModel } from "./admission.js";

const scratch = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const first = { runId: "run-a", issueId: "issue-a", stateDir: "/seat-a" };
const second = { runId: "run-b", issueId: "issue-b", stateDir: "/seat-b" };

describe("agy Claude/GPT host admission", () => {
  it("serializes different seats and allows admission after release", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-admission-"));
    try {
      const results = await Promise.allSettled([
        claimAgyHostAdmission(root, first, false), claimAgyHostAdmission(root, second, false),
      ]);
      const acquired = results.filter(result => result.status === "fulfilled");
      expect(acquired).toHaveLength(1);
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
      await (acquired[0] as PromiseFulfilledResult<() => Promise<void>>).value();
      const release = await claimAgyHostAdmission(root, second, false);
      await release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains uncertain work and only permits its exact seat to reattach", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-admission-"));
    try {
      await claimAgyHostAdmission(root, first, false);
      await expect(claimAgyHostAdmission(root, second, true)).rejects.toThrow(/unresolved/);
      await expect(claimAgyHostAdmission(root, first, false)).rejects.toThrow(/unresolved/);
      await expect(claimAgyHostAdmission(root, { ...first, stateDir: "/other" }, true)).rejects.toThrow(/unresolved/);
      const release = await claimAgyHostAdmission(root, first, true);
      await release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not reclaim an incomplete or malformed admission", async () => {
    const root = await mkdtemp(path.join(scratch, "agy-admission-"));
    try {
      await mkdir(path.join(root, "active"));
      await expect(claimAgyHostAdmission(root, first, true)).rejects.toThrow(/unresolved/);
      await writeFile(path.join(root, "active", "owner.json"), "{");
      await expect(claimAgyHostAdmission(root, first, true)).rejects.toThrow(/unresolved/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("only releases after a fresh matching idle observation following the receipt", () => {
    const now = Date.now();
    const status = { agentState: "idle", conversationId: "conversation", pendingInputCount: 0,
      toolConfirmationPending: false, observedAt: new Date(now).toISOString() };
    expect(isAgyAdmissionIdle(status, "conversation", now - 1, now)).toBe(true);
    expect(isAgyAdmissionIdle(status, null, now - 1, now)).toBe(false);
    expect(isAgyAdmissionIdle(status, "other", now - 1, now)).toBe(false);
    expect(isAgyAdmissionIdle(status, "conversation", now + 1, now)).toBe(false);
    expect(isAgyAdmissionIdle({ ...status, pendingInputCount: 1 }, "conversation", now - 1, now)).toBe(false);
    expect(isAgyAdmissionIdle({ ...status, agentState: "working" }, "conversation", now - 1, now)).toBe(false);
    expect(isAgyAdmissionIdle(status, "conversation", now - 20_000, now + 20_000)).toBe(false);
  });

  it("limits Claude and GPT while Gemini bypasses host admission", () => {
    expect(isAgyHostLimitedModel("claude-opus-5-5-high")).toBe(true);
    expect(isAgyHostLimitedModel("gpt-6-high")).toBe(true);
    expect(isAgyHostLimitedModel("gemini-4-argon-high")).toBe(false);
  });
});
