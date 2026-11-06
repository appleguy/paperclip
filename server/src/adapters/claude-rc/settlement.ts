/** F07: a receipt is an intent; only verified, durably recorded delivery frees a seat. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { ActivityEvent, IssueExecutionState } from "@paperclipai/shared";
import { adoptableActive, parseReceipt, type Receipt } from "../agy/execute.js";

type Outcome = { kind: "done"; receipt: Receipt } | { kind: "block"; reason: string };
type Settlement = {
  version: 1; agentId: string; runId: string; issueId: string; outcome: Outcome; fingerprint: string;
  status: "done" | "blocked" | "in_review"; reportRevisionId: string | null;
  reviewDecisionId?: string;
};
type Intent = {
  version: 1; runId: string; issueId: string; fingerprint: string; status: "done" | "blocked";
  agentId?: string; deliveryRunId?: string;
  review?: { stageId: string; stageType: "review" | "approval"; previousDecisionId: string | null };
};
type IssueStatus = { status?: unknown; assigneeAgentId?: unknown; executionState?: IssueExecutionState | null };
const fingerprint = (outcome: Outcome) => createHash("sha256").update(JSON.stringify(outcome)).digest("hex");
const markerPath = (stateDir: string, runId: string) => path.join(stateDir, `settled-${runId}.json`);
const intentPath = (stateDir: string, runId: string) => path.join(stateDir, `settling-${runId}.json`);

async function readIntent(stateDir: string, runId: string, issueId: string, agentId: string, hash: string): Promise<Intent | null> {
  const raw = await fs.readFile(intentPath(stateDir, runId), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  const intent = JSON.parse(raw) as Intent;
  if (intent?.version !== 1 || intent.runId !== runId || intent.issueId !== issueId || intent.fingerprint !== hash
    || (intent.status !== "done" && intent.status !== "blocked") || (intent.agentId !== undefined && intent.agentId !== agentId)
    || (intent.review && (intent.agentId !== agentId || !intent.deliveryRunId || !intent.review.stageId
      || !["review", "approval"].includes(intent.review.stageType)
      || (intent.review.previousDecisionId !== null && typeof intent.review.previousDecisionId !== "string"))))
    throw new Error("Claude RC status intent does not match the source operation; scoped reconciliation required");
  return intent;
}

/** Review state alone is not evidence: the recorded update must identify our exact stage decision. */
async function verifiedReviewDecision(invoke: ReturnType<typeof localApi>, route: string, intent: Intent): Promise<string> {
  const activity = await invoke("GET", `${route}/activity`) as ActivityEvent[];
  if (Array.isArray(activity)) for (const event of activity) {
    if (event.action !== "issue.updated" || event.entityType !== "issue" || event.entityId !== intent.issueId
      || event.actorType !== "agent" || event.actorId !== intent.agentId || event.agentId !== intent.agentId
      || event.runId !== intent.deliveryRunId) continue;
    const change = (event.details?.changes as Record<string, unknown> | undefined)?.executionState as
      { from?: IssueExecutionState; to?: IssueExecutionState } | undefined;
    const before = change?.from;
    const after = change?.to;
    if (before?.status === "pending" && before.currentStageId === intent.review!.stageId
      && before.currentStageType === intent.review!.stageType && before.currentParticipant?.type === "agent"
      && before.currentParticipant.agentId === intent.agentId && before.lastDecisionId === intent.review!.previousDecisionId
      && after?.completedStageIds?.includes(intent.review!.stageId) && after.lastDecisionOutcome === "approved"
      && typeof after.lastDecisionId === "string" && after.lastDecisionId && after.lastDecisionId !== before.lastDecisionId)
      return after.lastDecisionId;
  }
  throw new Error("Claude RC review decision not verified for the source stage; scoped reconciliation required");
}

async function durableWrite(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(temp, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

async function readSettlement(stateDir: string, runId: string, issueId: string, agentId: string): Promise<Settlement | null> {
  try {
    const s = JSON.parse(await fs.readFile(markerPath(stateDir, runId), "utf8")) as Settlement;
    if (s.version !== 1 || s.agentId !== agentId || s.runId !== runId || s.issueId !== issueId || !s.outcome) return null;
    if (s.outcome.kind === "done") {
      const receipt = parseReceipt(JSON.stringify(s.outcome.receipt), runId, issueId);
      // Normalize to the exact validated receipt fields when comparing persisted evidence.
      if ((s.status !== "done" && s.status !== "in_review") || typeof s.reportRevisionId !== "string" || !s.reportRevisionId || !receipt) return null;
      if (s.status === "in_review") {
        const intent = await readIntent(stateDir, runId, issueId, agentId, s.fingerprint);
        // Older F3 markers were written without ever attempting a transition.
        // Legacy worker-to-review markers do have a matching durable intent.
        if (!intent || intent.status !== "done" || (intent.review && !s.reviewDecisionId)) return null;
      }
    } else if (s.outcome.kind !== "block" || s.status !== "blocked"
      || typeof s.outcome.reason !== "string" || !s.outcome.reason.trim()) return null;
    return s.fingerprint === fingerprint(s.outcome) ? s : null;
  } catch { return null; }
}

function localApi(ctx: AdapterExecutionContext) {
  if (!ctx.authToken) throw new Error("missing scoped token for Claude RC settlement");
  const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid local Paperclip listen port");
  return async (method: string, route: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) throw new Error(`Claude RC settlement ${method} returned HTTP ${response.status}`);
    return response.json(); // Missing or malformed acknowledgement is not settlement.
  };
}

/** The done gate and this exact receipt's transition were already accepted. */
export async function isReviewContinuation(
  ctx: AdapterExecutionContext, stateDir: string, sourceRunId: string, issueId: string, receipt: Receipt,
): Promise<boolean> {
  const settled = await readSettlement(stateDir, sourceRunId, issueId, ctx.agent.id);
  return settled?.status === "in_review" && settled.fingerprint === fingerprint({ kind: "done", receipt });
}

/** Called only after the done gate; every write is under a fresh run for this issue. */
export async function settleOutcome(
  ctx: AdapterExecutionContext, stateDir: string, sourceRunId: string, issueId: string, outcome: Outcome,
): Promise<Settlement> {
  const scopedIssue = ctx.context.issueId ?? ctx.context.taskId;
  if (scopedIssue !== issueId) throw new Error("Claude RC settlement requires the original issue scope");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sourceRunId)) throw new Error("invalid settlement source run");
  if (outcome.kind === "done") parseReceipt(JSON.stringify(outcome.receipt), sourceRunId, issueId);
  else if (!outcome.reason.trim()) throw new Error("empty blocker settlement");
  const prior = await readSettlement(stateDir, sourceRunId, issueId, ctx.agent.id);
  if (prior && prior.fingerprint !== fingerprint(outcome))
    throw new Error("Claude RC source operation already settled with a different outcome");
  if (prior?.status !== "in_review" && prior) return prior;
  const invoke = localApi(ctx);
  const route = `issues/${encodeURIComponent(issueId)}`;
  let reportRevisionId: string | null = null;
  if (outcome.kind === "done") {
    const existing = await invoke("GET", `${route}/documents/report`) as { body?: unknown; latestRevisionId?: unknown } | null;
    if (existing !== null && (typeof existing?.latestRevisionId !== "string" || !existing.latestRevisionId))
      throw new Error("Claude RC report response missing revision");
    if (existing?.body !== outcome.receipt.report) {
      const saved = await invoke("PUT", `${route}/documents/report`, {
        title: "Claude Code execution report", format: "markdown", body: outcome.receipt.report,
        changeSummary: `Claude Remote Control source run ${sourceRunId}`,
        baseRevisionId: typeof existing?.latestRevisionId === "string" ? existing.latestRevisionId : null,
      }) as { body?: unknown; latestRevisionId?: unknown } | null;
      if (saved?.body !== outcome.receipt.report || typeof saved.latestRevisionId !== "string" || !saved.latestRevisionId)
        throw new Error("Claude RC report acknowledgement did not verify the receipt");
    }
    const report = await invoke("GET", `${route}/documents/report`) as { body?: unknown; latestRevisionId?: unknown } | null;
    if (report?.body !== outcome.receipt.report || typeof report.latestRevisionId !== "string" || !report.latestRevisionId)
      throw new Error("Claude RC report readback did not verify the receipt");
    reportRevisionId = report.latestRevisionId;
  }
  const status = outcome.kind === "done" ? "done" : "blocked";
  let issue = await invoke("GET", route) as IssueStatus | null;
  if (typeof issue?.status !== "string") throw new Error("Claude RC issue response missing status");
  let intent = await readIntent(stateDir, sourceRunId, issueId, ctx.agent.id, fingerprint(outcome));
  let reviewDecisionId = prior?.reviewDecisionId;
  if (!prior && !intent && issue.status !== status) {
    const state = issue.executionState;
    const reviewing = outcome.kind === "done" && issue.status === "in_review";
    if (reviewing && (issue.assigneeAgentId !== ctx.agent.id || state?.status !== "pending"
      || state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== ctx.agent.id
      || !state.currentStageId || (state.currentStageType !== "review" && state.currentStageType !== "approval")))
      throw new Error("Claude RC first review receipt requires the assigned current reviewer and stage; checkpoint retained");
    intent = { version: 1, runId: sourceRunId, issueId, fingerprint: fingerprint(outcome), status,
      agentId: ctx.agent.id, deliveryRunId: ctx.runId,
      ...(reviewing ? { review: { stageId: state!.currentStageId!, stageType: state!.currentStageType as "review" | "approval",
        previousDecisionId: state!.lastDecisionId } } : {}) };
    // A PATCH may have advanced a review stage even when it did not produce the
    // requested status. Never repeat an uncertain transition as another approval.
    await durableWrite(intentPath(stateDir, sourceRunId), intent);
    // The blocker comment and transition share one issue update, avoiding duplicate comments on recovery.
    const patched = await invoke("PATCH", route, { status, ...(outcome.kind === "block" ? {
      comment: `Claude Remote Control blocked: ${outcome.reason}`,
      // A worker-reported block is routed to Board: a self-owned descriptor is rejected (SCO-1105) and would retain the checkpoint.
      unblockDescriptor: { owner: "board" as const, action: `Resolve the worker-reported blocker, then reassign or reopen:\n${outcome.reason}`.slice(0, 2000) },
    } : intent.review && outcome.kind === "done" ? {
      comment: `Approved: ${outcome.receipt.summary}\n\nClaude Remote Control source run ${sourceRunId}; stage ${intent.review.stageId}.`,
    } : {}) }) as IssueStatus | null;
    if (typeof patched?.status !== "string") throw new Error("Claude RC status acknowledgement missing status; checkpoint retained");
    issue = await invoke("GET", route) as IssueStatus | null;
  }
  if (intent?.review && !reviewDecisionId) reviewDecisionId = await verifiedReviewDecision(invoke, route, intent);
  if (issue?.status !== status && !(outcome.kind === "done" && issue?.status === "in_review"))
    throw new Error(`Claude RC outcome remains ${String(issue?.status)}; checkpoint retained`);
  const settlement: Settlement = {
    version: 1, agentId: ctx.agent.id, runId: sourceRunId, issueId, outcome, fingerprint: fingerprint(outcome),
    status: issue.status as Settlement["status"], reportRevisionId,
    ...(reviewDecisionId ? { reviewDecisionId } : {}),
  };
  await durableWrite(markerPath(stateDir, sourceRunId), settlement);
  return settlement;
}

/** A foreign run cannot deliver this outcome. Queue a scoped adoption, retaining the original checkpoint. */
export async function reconcileForeignSettlement(
  ctx: AdapterExecutionContext, stateDir: string, activePath: string,
): Promise<void> {
  const raw = await fs.readFile(activePath, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!raw) return;
  let owner: { issueId?: unknown };
  try { owner = JSON.parse(raw); } catch { return; } // Existing adoption rejects unreadable ownership.
  const currentIssue = ctx.context.issueId ?? ctx.context.taskId;
  if (!owner || typeof owner.issueId !== "string" || owner.issueId === currentIssue) return;
  const active = adoptableActive(raw, owner.issueId, stateDir, "claude_rc_local");
  if (!active) return;
  const settled = await readSettlement(stateDir, active.runId, active.issueId, ctx.agent.id);
  let receiptMatches = false;
  if (settled?.outcome.kind === "done") {
    try {
      const receipt = parseReceipt(await fs.readFile(active.receiptPath, "utf8"), active.runId, active.issueId);
      receiptMatches = fingerprint({ kind: "done", receipt }) === settled.fingerprint;
    } catch { /* Torn or replaced receipt is never proof of delivery. */ }
  }
  if (settled && settled.status !== "in_review" && (settled.outcome.kind === "block" || receiptMatches)) {
    await fs.rename(activePath, path.join(stateDir, `active.settled-${active.runId}.json`));
    const dir = await fs.open(stateDir, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    await ctx.onLog("stdout", `[claude-rc] Archived verified settlement for original issue ${active.issueId}\n`);
    return;
  }
  try {
    await localApi(ctx)("POST", `agents/${encodeURIComponent(ctx.agent.id)}/wakeup`, {
      source: "on_demand", triggerDetail: "system", reason: "claude_rc_checkpoint_recovery",
      payload: { issueId: active.issueId }, idempotencyKey: `claude-rc-settlement:${active.runId}`,
    });
    await ctx.onLog("stdout", `[claude-rc] Requested scoped recovery for original issue ${active.issueId}; checkpoint retained\n`);
  } catch (error) {
    await ctx.onLog("stderr", `[claude-rc] Scoped recovery request failed; checkpoint retained: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  throw new Error(`claude_rc_local previous task unresolved; original issue ${active.issueId} requires scoped settlement; never replay actions`);
}
