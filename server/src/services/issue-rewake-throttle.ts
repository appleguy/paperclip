import { createHash } from "node:crypto";

/**
 * PAP-13775 / SCO-888: a durable meaningful-delta fingerprint prevents repeated
 * own-comment, monitor and retry wakes from buying another reasoning turn.
 * The cooldown remains the fallback for historical runs without a fingerprint.
 * Assignments, other-author comments, blocker resolutions and human answers
 * always pass; unknown attribution is never evidence for suppression.
 */

/** Consecutive no-progress runs required before the cooldown engages. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/** Cooldown after the threshold streak; doubles per additional no-progress run. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 120_000;

/** Upper bound for the escalating cooldown. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;

/** Only runs newer than this feed the streak; older history is ignored. */
export const ISSUE_REWAKE_LOOKBACK_MS = 6 * 60 * 60_000;

/** How many recent terminal runs to sample when computing the streak. */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * Wake reasons that assert issue state rather than deliver a new event.
 * Only known poll/retry/monitor reasons are eligible. Unknown reasons pass.
 */
export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_queue_drive",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_graph_liveness_backstop",
  "issue_monitor_due",
  "heartbeat_timer",
  "target_busy_retry",
  "dispatch_deferred_retry",
  "process_lost_retry",
  "run_liveness_continuation",
  "scheduled_retry",
  "transient_failure_retry",
  "issue_continuation",
  "issue_disposition_repair",
  "issue_recovery_action_restored",
  "issue_recovery_handoff",
  "issue_review_path_lost",
  "provider_quota_recovery",
  "retry",
]);

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * Narration and timer scheduling do not reset the streak. Actual workspace
 * changes are represented separately by the durable workspace.diff projection.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.approval_linked",
];

/**
 * Activity on the issue that counts as new external input since the last run
 * finished — anything a waiting agent should be woken for, including board
 * responses to interactions.
 */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  ...ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  "issue.comment_added",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
];

/** Actual state fields; execution locks, timestamps and monitor metadata are bookkeeping. */
export const ISSUE_WAKE_STATE_FIELDS = [
  "title", "description", "status", "priority", "assigneeAgentId", "assigneeUserId",
  "parentId", "projectId", "projectWorkspaceId", "executionWorkspaceId", "workMode",
  "dueAt", "labelIds", "cycleId", "blockedByIssueIds", "unblockDescriptor",
] as const;

/** Durable receipts consume this server-derived fingerprint under the issue lock. */
export const ISSUE_WAKE_DELTA_KEY = "issueWakeDelta";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function buildIssueWakeFingerprint(input: {
  activity: string | null;
  state: unknown;
  result: { status: string; errorCode: string | null; error?: string | null; exitCode: number | null; signal: string | null } | null;
  config: unknown;
  work: unknown;
}): string {
  return createHash("sha256").update(stable({ version: 1, ...input })).digest("hex");
}

export function shouldSuppressIssueWakeDelta(input: {
  candidate: boolean;
  fingerprint: string;
  consumedFingerprint: string | null;
}): boolean {
  return input.candidate && input.consumedFingerprint === input.fingerprint;
}

export interface IssueRewakeCandidateInput {
  reason: string | null;
  wakeCommentId: string | null;
  requestedByActorType?: "user" | "agent" | "system" | null;
  /** Resolved from the stored comment, never the caller's actor assertion. */
  commentAuthorAgentId?: string | null;
  agentId?: string;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}

/**
 * Whether a wake is even a candidate for throttling. Wakes that carry new
 * information or an explicit operator escalation always pass.
 */
export function isThrottleCandidateIssueRewake(input: IssueRewakeCandidateInput): boolean {
  if (input.forceFreshSession) return false;
  if (input.requestedByActorType === "user") return false;
  // An event delivery can carry a comment cursor from earlier context. That
  // cursor must never turn an assignment or blocker resolution into a poll.
  if (["issue_assigned", "issue_blockers_resolved", "issue_children_completed"].includes(input.reason ?? "")) return false;
  // Explicit resume is an operator privilege, not an actor-class escape hatch.
  // Agent-authored resume comments remain subject to the normal rewake throttle.
  if (input.hasExplicitResume && input.requestedByActorType !== "agent") return false;
  if (input.wakeCommentId) return Boolean(input.agentId && input.commentAuthorAgentId === input.agentId);
  if (input.reason === null) return false;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason);
}

export interface RecentIssueRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
  errorCode?: string | null;
  error?: string | null;
  exitCode?: number | null;
  signal?: string | null;
}

export interface IssueRewakeThrottleInput {
  now: Date;
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: RecentIssueRunSample[];
  /** Runs among the sample that produced issue-visible progress. */
  runIdsWithIssueProgress: ReadonlySet<string>;
  /** New issue input landed after the newest run finished. */
  hasNewIssueInputSinceLastRun: boolean;
}

export type IssueRewakeThrottleDecision =
  | { blocked: false; noProgressStreak: number }
  | {
      blocked: true;
      noProgressStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function computeIssueRewakeCooldownMs(noProgressStreak: number): number {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  // Guard the exponent so an absurd streak can't overflow into Infinity.
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

export function evaluateIssueRewakeThrottle(input: IssueRewakeThrottleInput): IssueRewakeThrottleDecision {
  const runs = input.recentTerminalRuns;
  if (runs.length === 0) return { blocked: false, noProgressStreak: 0 };
  if (input.hasNewIssueInputSinceLastRun) return { blocked: false, noProgressStreak: 0 };

  let noProgressStreak = 0;
  for (const run of runs) {
    if (!run.finishedAt) break;
    if (run.status !== "succeeded") {
      // Pre-provider cancellations/interruption bookkeeping is not a failed
      // reasoning attempt. Preserve its recovery path in historical samples.
      if (run.status !== "failed") break;
      // The first failure remains recoverable. Only an identical repeat feeds
      // the streak; a new failure/result is meaningful input.
      const older = runs[noProgressStreak + 1];
      if (!run.errorCode || !older || older.status !== run.status || older.errorCode !== run.errorCode
        || older.error !== run.error || older.exitCode !== run.exitCode || older.signal !== run.signal) break;
    }
    if (input.runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  const lastRunFinishedAt = runs[0]?.finishedAt;
  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };

  const cooldownMs = computeIssueRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}
