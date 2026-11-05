import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildIssueWakeFingerprint, isThrottleCandidateIssueRewake, shouldSuppressIssueWakeDelta } from "../services/issue-rewake-throttle.js";

/** C4 supplies immutable activity/version IDs; no private wake data enters Git. */
function replay(tsv: string) {
  const [header, ...lines] = tsv.trimEnd().split("\n").map(line => line.split("\t"));
  const rows = lines.map(values => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
  type Result = Parameters<typeof buildIssueWakeFingerprint>[0]["result"];
  const states = new Map<string, { events: Set<string>; fingerprint: string | null; version: number; result: Result }>();
  const byTrigger: Record<string, { total: number; suppressed: number; kept: number; uncertain: number }> = {};
  let falseSuppressions = 0;
  let protectedSuppressions = 0;
  for (const row of rows.sort((a, b) => a.created_at_utc.localeCompare(b.created_at_utc))) {
    const key = `${row.agent_id}:${row.issue_id}`;
    const state = states.get(key) ?? { events: new Set<string>(), fingerprint: null, version: 0, result: null };
    const events = row.matched_delta_event_ids.split(";").filter(Boolean);
    if (events.some(event => !state.events.has(event))) state.version++;
    const fingerprint = buildIssueWakeFingerprint({ activity: `events-${state.version}`,
      state: null, result: state.result, config: null, work: null });
    const uncertain = row.simulated_action === "uncertain" || !row.issue_id;
    const candidate = !uncertain && (!state.result || state.result.status === "succeeded" || Boolean(state.result.errorCode)) && isThrottleCandidateIssueRewake({
      reason: row.raw_wake_reason || null,
      wakeCommentId: ["own_comment", "comment_by_another_author", "comment_author_unknown"].includes(row.trigger) ? "stored-comment" : null,
      agentId: row.agent_id,
      commentAuthorAgentId: row.comment_author_agent_id || null,
      requestedByActorType: row.comment_actor_type === "user" ? "user" : row.comment_actor_type === "agent" ? "agent" : "system",
      forceFreshSession: false, hasExplicitResume: false,
    });
    const suppressed = shouldSuppressIssueWakeDelta({ candidate, fingerprint, consumedFingerprint: state.fingerprint });
    const protectedWake = ["assignment", "comment_by_another_author", "blocker_change", "human_answer"].includes(row.trigger) || row.comment_actor_type === "user";
    if (suppressed && row.simulated_action === "keep") falseSuppressions++;
    if (suppressed && protectedWake) protectedSuppressions++;
    const counts = byTrigger[row.trigger] ??= { total: 0, suppressed: 0, kept: 0, uncertain: 0 };
    counts.total++;
    counts[suppressed ? "suppressed" : uncertain ? "uncertain" : "kept"]++;
    if (!suppressed) {
      events.forEach(event => state.events.add(event));
      state.fingerprint = fingerprint;
      if (["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(row.run_status)) {
        state.result = { status: row.run_status, errorCode: row.error_code || null, exitCode: null, signal: null };
      }
    }
    states.set(key, state);
  }
  return { total: rows.length, suppressed: Object.values(byTrigger).reduce((sum, row) => sum + row.suppressed, 0),
    falseSuppressions, protectedSuppressions, byTrigger };
}

describe("C4 meaningful-delta replay", () => {
  it("retains protected wakes and consumes each event once", () => {
    const fields = ["created_at_utc", "agent_id", "issue_id", "raw_wake_reason", "trigger", "comment_author_agent_id", "comment_actor_type", "simulated_action", "matched_delta_event_ids"];
    const row = (time: number, reason: string, trigger: string, author: string, action: string, events: string) =>
      [`time-${time}`, "a", "issue", reason, trigger, author, author ? "agent" : "system", action, events].join("\t");
    const result = replay([fields.join("\t"),
      row(1, "issue_assigned", "assignment", "", "keep", "state-a"),
      row(2, "issue_monitor_due", "monitor", "", "suppress", "state-a"),
      row(3, "issue_commented", "own_comment", "a", "suppress", "state-a"),
      row(4, "issue_commented", "comment_by_another_author", "b", "keep", "state-a"),
      row(5, "issue_monitor_due", "monitor", "", "keep", "state-b"),
    ].join("\n"));
    expect(result).toMatchObject({ total: 5, suppressed: 2, falseSuppressions: 0, protectedSuppressions: 0 });
  });

  const input = process.env.PAPERCLIP_C4_WAKE_REPLAY;
  it.skipIf(!input)("replays the supplied seven-day labelled wake set", () => {
    const result = replay(readFileSync(input!, "utf8"));
    if (process.env.PAPERCLIP_C4_REPLAY_RECEIPT) {
      writeFileSync(process.env.PAPERCLIP_C4_REPLAY_RECEIPT, `${JSON.stringify(result, null, 2)}\n`);
    }
    expect(result.total).toBe(4848);
    expect(result.falseSuppressions).toBe(0);
    expect(result.protectedSuppressions).toBe(0);
  });
});
