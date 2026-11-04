import { describe, expect, it } from "vitest";
import { isClaudeIdle, parseClaudeRcUrl, projectDir } from "./execute.js";

const rule = "─".repeat(40) + " Paperclip Claude ─";
const footer = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("claude_rc_local screen parsing", () => {
  it("treats the empty input box with the permission footer as idle", () => {
    expect(isClaudeIdle([rule, "❯ ", "─".repeat(40), footer].join("\n"))).toBe(true);
    expect(isClaudeIdle([rule, '❯ Try "how does <filepath> work?"', "─".repeat(40), footer].join("\n"))).toBe(true);
  });
  it("is busy while a turn runs or a dialog is open", () => {
    expect(isClaudeIdle(["✻ Thinking… (12s · esc to interrupt)", rule, "❯ ", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle(["Do you want to proceed?", "❯ 1. Yes", "  2. No", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle("starting…")).toBe(false);
  });
  it("parses the RC session URL and the transcript directory", () => {
    expect(parseClaudeRcUrl("Continue at https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV now"))
      .toBe("https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV");
    expect(projectDir("/Volumes/NVM/Paperclip/tmp/claude-rc-scratch"))
      .toMatch(/\.claude\/projects\/-Volumes-NVM-Paperclip-tmp-claude-rc-scratch$/);
  });
});

import fsp from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { reconcileOrphanActive } from "./execute.js";
import { adoptableActive } from "../agy/execute.js";

describe("SCO-626 orphan active.json after deploy cancel", () => {
  const mk = async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "rc-orphan-"));
    const activePath = nodePath.join(dir, "active.json");
    await fsp.writeFile(activePath, JSON.stringify({ runId: "r1", op_id: "r1", issueId: "A", receiptPath: nodePath.join(dir, "receipt-r1.json"), conversationId: "c1" }));
    return { dir, activePath };
  };
  const base = (d: { dir: string; activePath: string }, live: boolean, idle: boolean) => ({
    stateDir: d.dir, activePath: d.activePath, issueId: "B", runId: "r2",
    live: async () => live, paneIdle: async () => idle, log: () => {},
  });
  it("archives as unverified when idle, no receipt", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive(base(d, false, true))).toBe("archived");
    await expect(fsp.stat(d.activePath)).rejects.toThrow();
    await fsp.stat(nodePath.join(d.dir, "active.unverified-r1.json"));
  });
  it("keeps the checkpoint while the conversation is live or busy", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive(base(d, true, true))).toBe("kept");
    expect(await reconcileOrphanActive(base(d, false, false))).toBe("kept");
    await fsp.stat(d.activePath);
  });
  it("leaves same-issue (adoptable) checkpoints alone", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive({ ...base(d, false, true), issueId: "A" })).toBe("none");
  });
  it("error text names the adapter", () => {
    expect(() => adoptableActive("{}", "B", "/x", "claude_rc_local")).toThrow(/^claude_rc_local previous task unresolved/);
  });
});
