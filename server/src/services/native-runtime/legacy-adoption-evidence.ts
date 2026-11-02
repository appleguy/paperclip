import { DatabaseSync } from "node:sqlite";

/** Read-only evidence for a server-owned OpenCode v2 journal path. This module
 * never settles a run: native messages are not a Paperclip result receipt. */
export function readLegacyAdoptionEvidence(input: {
  journalPath: string;
  /** Native ID independently extracted from this exact run's persisted event stream. */
  runBoundSessionId: string;
}) {
  if (!/^ses_[A-Za-z0-9]{10,72}$/.test(input.runBoundSessionId)) throw new Error("legacy_adoption_invalid_session_id");
  const db = new DatabaseSync(input.journalPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const exact = db.prepare("SELECT id FROM session_v2 WHERE id = ? LIMIT 2").all(input.runBoundSessionId);
    if (exact.length !== 1) return { state: "session_not_found" as const, delivery: "unknown" as const, requiresReconciliation: true };
    // SQLite does not expose contents to the caller and bounds returned row size.
    const last = db.prepare("SELECT seq, type, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data ELSE NULL END AS data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(input.runBoundSessionId) as { seq: number; type: string; data: string | null } | undefined;
    if (!last) return { state: "no_messages" as const, delivery: "unknown" as const, requiresReconciliation: true };
    if (typeof last.data !== "string") return { state: "evidence_unavailable" as const, delivery: "unknown" as const, requiresReconciliation: true };
    let parsed: unknown; try { parsed = JSON.parse(last.data); } catch { return { state: "evidence_unavailable" as const, delivery: "unknown" as const, requiresReconciliation: true }; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "evidence_unavailable" as const, delivery: "unknown" as const, requiresReconciliation: true };
    const value = parsed as Record<string, unknown>;
    const status = typeof value.status === "string" && ["running", "completed", "failed"].includes(value.status) ? value.status : null;
    const parts = Array.isArray(value.content) ? value.content.slice(0, 256) : [];
    const toolStates = parts.filter((part): part is Record<string, unknown> => !!part && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "tool")
      .map(part => { const s = part.state; const status = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>).status : null;
        return typeof status === "string" && ["pending", "running", "streaming", "completed", "error"].includes(status) ? status : "unknown"; });
    const messageType = ["assistant", "user", "compaction"].includes(last.type) ? last.type : "unknown";
    return { state: "observed" as const, lastSeq: last.seq, messageType, compactionStatus: last.type === "compaction" ? status : null,
      toolStates, delivery: "unknown" as const, requiresReconciliation: true };
  } finally { db.close(); }
}
