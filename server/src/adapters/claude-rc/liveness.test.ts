import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeRcConversationLive, type ClaudeRcLivenessDeps } from "./liveness.js";
import { projectDir } from "./execute.js";

const cfg = { stateDir: "/s", cwd: "/Volumes/NVM/Paperclip/workspaces/claude-rc", liveWindowSec: 600 };
const NOW = 1_000_000_000;
const jsonl = path.join(projectDir(cfg.cwd), "conv-1.jsonl");
function deps(o: { active?: object | null; mtime?: number | null; idle?: boolean | null }): ClaudeRcLivenessDeps {
  return {
    readFile: async () => (o.active ? JSON.stringify(o.active) : ""),
    mtimeMs: async p => (p === jsonl ? o.mtime ?? null : null),
    paneIdle: async () => o.idle ?? null,
    now: () => NOW,
  };
}
const active = { issueId: "I1", conversationId: "conv-1" };

describe("claudeRcConversationLive (SCO-648)", () => {
  it("live when jsonl is fresh even if the pane looks idle", async () => {
    expect(await claudeRcConversationLive(cfg, "I1", deps({ active, mtime: NOW - 5_000, idle: true }))).toBe(true);
  });
  it("live when jsonl is stale but the pane is busy", async () => {
    expect(await claudeRcConversationLive(cfg, "I1", deps({ active, mtime: NOW - 3_600_000, idle: false }))).toBe(true);
  });
  it("not live when jsonl is stale and pane idle", async () => {
    expect(await claudeRcConversationLive(cfg, "I1", deps({ active, mtime: NOW - 3_600_000, idle: true }))).toBe(false);
  });
  it("not live when the pane cannot be read and jsonl is stale", async () => {
    expect(await claudeRcConversationLive(cfg, "I1", deps({ active, mtime: null, idle: null }))).toBe(false);
  });
  it("checkpoint for a different issue does not protect this issue", async () => {
    expect(await claudeRcConversationLive(cfg, "I2", deps({ active, mtime: NOW - 1000, idle: false }))).toBe(false);
  });
  it("seat-level probe (no issue) accepts any checkpoint; no checkpoint is not live", async () => {
    expect(await claudeRcConversationLive(cfg, null, deps({ active, mtime: NOW - 1000 }))).toBe(true);
    expect(await claudeRcConversationLive(cfg, null, deps({ active: null, mtime: NOW - 1000, idle: false }))).toBe(false);
  });
});
