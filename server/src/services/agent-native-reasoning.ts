/**
 * Read-only OpenCode reasoning that is saved in SQLite but omitted from the
 * JSON process stream. Only fixed, locally installed backend profiles are
 * supported. A Paperclip run log must establish the exact native session ID.
 */
import { DatabaseSync } from "node:sqlite";

const PROFILES: Readonly<Record<string, string>> = {
  "native-fleet/wrx80/glm-5.3-flash-colibri":
    "/Volumes/NVM/Paperclip/backends/opencode-glm-flash/data/opencode/opencode.db",
  "mac-pro/mtplx-flash-next-optimized-quality":
    "/Volumes/NVM/Paperclip/backends/opencode-qwen-quality/data/opencode/opencode.db",
};
const SESSION_RE = /^ses_[a-zA-Z0-9]{10,72}$/;
const MAX_ROWS = 120;
const MAX_TEXT_CHARS = 40_000;

export type NativeReasoning = {
  available: boolean;
  source: "opencode_sqlite" | null;
  sessionId: string | null;
  truncated: boolean;
  parts: Array<{ id: string; seq: number; ts: string; text: string; truncated: boolean }>;
};

export function openCodeSessionIdFromRunLog(content: string): string | null {
  for (const line of content.split("\n").slice(0, 40)) {
    try {
      const record = JSON.parse(line) as { chunk?: unknown };
      if (typeof record.chunk !== "string") continue;
      const event = JSON.parse(record.chunk) as { sessionID?: unknown };
      if (typeof event.sessionID === "string" && SESSION_RE.test(event.sessionID)) return event.sessionID;
    } catch { /* Skip incomplete or non-OpenCode records. */ }
  }
  return null;
}

export function readNativeReasoning(model: string, sessionId: string | null, startedAt: Date | string | null = null, finishedAt: Date | string | null = null): NativeReasoning {
  const empty = (): NativeReasoning => ({ available: false, source: null, sessionId: null, truncated: false, parts: [] });
  const path = PROFILES[model];
  if (!path || !sessionId || !SESSION_RE.test(sessionId)) return empty();
  const since = startedAt ? new Date(startedAt).getTime() : NaN;
  const until = finishedAt ? new Date(finishedAt).getTime() : Date.now() + 60_000;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return empty();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
    const exists = db.prepare("SELECT id FROM session_v2 WHERE id = ? LIMIT 1").get(sessionId);
    if (!exists) return empty();
    const rows = db.prepare(
      "SELECT seq, time_created, data FROM session_message WHERE session_id = ? AND time_created >= ? AND time_created <= ? ORDER BY seq DESC LIMIT ?",
    ).all(sessionId, since, until, MAX_ROWS + 1) as Array<{ seq: number; time_created: number; data: string }>;
    const truncated = rows.length > MAX_ROWS;
    const parts: NativeReasoning["parts"] = [];
    for (const row of rows.slice(0, MAX_ROWS).reverse()) {
      let parsed: { content?: unknown };
      try { parsed = JSON.parse(row.data); } catch { continue; }
      if (!Array.isArray(parsed.content)) continue;
      parsed.content.forEach((part: unknown, index: number) => {
        if (!part || typeof part !== "object") return;
        const value = part as { type?: unknown; text?: unknown };
        if (value.type !== "reasoning" || typeof value.text !== "string" || !value.text) return;
        const clipped = value.text.length > MAX_TEXT_CHARS;
        parts.push({
          id: `${row.seq}:${index}`, seq: row.seq,
          ts: new Date(Number(row.time_created)).toISOString(),
          text: clipped ? value.text.slice(0, MAX_TEXT_CHARS) : value.text,
          truncated: clipped,
        });
      });
    }
    return { available: true, source: "opencode_sqlite", sessionId, parts, truncated };
  } catch {
    return empty();
  } finally {
    try { db?.close(); } catch { /* Closed or invalid database. */ }
  }
}
