/**
 * Does a claude_rc seat still have a live conversation? Same signal the adapter
 * uses to extend its deadline and keep an orphan checkpoint (SCO-564/SCO-626):
 * transcript jsonl written within the live window, or a busy tmux pane.
 * Run recovery uses it so a deploy SIGTERM never blocks an issue (or errors the
 * agent) while the conversation is still working (SCO-648).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tmux } from "../agy/execute.js";
import { isClaudeIdle, projectDir } from "./execute.js";

export interface ClaudeRcLivenessDeps {
  readFile(p: string): Promise<string>;
  mtimeMs(p: string): Promise<number | null>;
  paneIdle(socket: string, session: string): Promise<boolean | null>;
  now(): number;
}

const defaultDeps: ClaudeRcLivenessDeps = {
  readFile: p => fs.readFile(p, "utf8").catch(() => ""),
  mtimeMs: async p => (await fs.stat(p).catch(() => null))?.mtimeMs ?? null,
  paneIdle: async (socket, session) => {
    try {
      const raw = await tmux(socket, ["capture-pane", "-t", `=${session}:`, "-p", "-J", "-e", "-S", "-150"]);
      return isClaudeIdle(raw.replace(/\x1b\[2m[^\x1b\n]*/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
    } catch { return null; }
  },
  now: Date.now,
};

const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);

/** The seat's live checkpoint (its active.json issue), or null when the conversation is not live. */
export async function claudeRcLiveCheckpoint(
  config: Record<string, unknown>,
  deps: ClaudeRcLivenessDeps = defaultDeps,
): Promise<{ issueId: string | null } | null> {
  const stateDir = path.resolve(str(config.stateDir, path.join(os.homedir(), ".paperclip/claude-rc-state")));
  const cwd = path.resolve(str(config.cwd, "/Volumes/NVM/Paperclip/workspaces/claude-rc"));
  const socket = str(config.tmuxSocket, "pc-claude-rc");
  const session = str(config.tmuxSession, "claude");
  const liveWindowMs = (Number(config.liveWindowSec) || 600) * 1000;
  let active: { issueId?: string; conversationId?: string | null; tmuxSocket?: string; tmuxSession?: string };
  try { active = JSON.parse(await deps.readFile(path.join(stateDir, "active.json"))); } catch { return null; }
  const checkpoint = { issueId: active.issueId ?? null };
  if (active.conversationId) {
    const m = await deps.mtimeMs(path.join(projectDir(cwd), `${active.conversationId}.jsonl`));
    if (m !== null && deps.now() - m < liveWindowMs) return checkpoint;
  }
  return (await deps.paneIdle(active.tmuxSocket ?? socket, active.tmuxSession ?? session)) === false ? checkpoint : null;
}

/** `issueId` set: only a checkpoint for that issue counts; otherwise any checkpoint on the seat. */
export async function claudeRcConversationLive(
  config: Record<string, unknown>,
  issueId: string | null,
  deps: ClaudeRcLivenessDeps = defaultDeps,
): Promise<boolean> {
  const live = await claudeRcLiveCheckpoint(config, deps);
  return live !== null && (!issueId || live.issueId === issueId);
}
