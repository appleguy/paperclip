import fs from "node:fs/promises";
import path from "node:path";

/**
 * keepConversation: the seat keeps one native Codex thread and resumes it on every wake,
 * across issues and projects, as claude-rc does. Codex compacts the thread itself
 * (model_auto_compact_token_limit), so context carries forward instead of resetting per issue.
 * The thread id lives in `${stateDir}/codex-shared-thread.json`; the seat must run one turn at a time.
 */
export type SharedCodexThread = { sessionId: string; cwd: string };

const threadFile = (stateDir: string) => path.join(stateDir, "codex-shared-thread.json");

export function sharedConversationStateDir(config: Record<string, unknown>): string | null {
  if (config.keepConversation !== true) return null;
  const dir = typeof config.stateDir === "string" ? config.stateDir.trim() : "";
  return dir && path.isAbsolute(dir) ? dir : null;
}

export async function readSharedCodexThread(stateDir: string): Promise<SharedCodexThread | null> {
  try {
    const value = JSON.parse(await fs.readFile(threadFile(stateDir), "utf8")) as Record<string, unknown>;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    return sessionId ? { sessionId, cwd: typeof value.cwd === "string" ? value.cwd : "" } : null;
  } catch {
    return null;
  }
}

export async function writeSharedCodexThread(stateDir: string, thread: SharedCodexThread): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = threadFile(stateDir);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ ...thread, updatedAt: new Date().toISOString() })}\n`, "utf8");
  await fs.rename(temp, target);
}

export async function clearSharedCodexThread(stateDir: string): Promise<void> {
  await fs.rm(threadFile(stateDir), { force: true });
}

/** Records the thread a finished run used, or forgets it when the run cleared its session. */
export async function settleSharedCodexThread(
  stateDir: string,
  result: { sessionId?: string | null; clearSession?: boolean },
  cwd: string,
): Promise<void> {
  if (result.sessionId) await writeSharedCodexThread(stateDir, { sessionId: result.sessionId, cwd });
  else if (result.clearSession) await clearSharedCodexThread(stateDir);
}
