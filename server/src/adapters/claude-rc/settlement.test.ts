import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { ActivityEvent, IssueExecutionState } from "@paperclipai/shared";
import { receiptFilePath } from "../agy/execute.js";
import { isReviewContinuation, reconcileForeignSettlement, settleOutcome } from "./settlement.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../../services/issue-execution-policy.js";
import { buildIssueChanges } from "../../services/issue-change-receipt.js";

const sourceRunId = "11111111-1111-4111-8111-111111111111";
const receipt = { runId: sourceRunId, issueId: "original", status: "done", summary: "Original work complete",
  report: "Original operation verified with committed work and durable evidence. ".repeat(6) };
const outcome = { kind: "done" as const, receipt };
let dir: string;
let activePath: string;
let report: { body: string; latestRevisionId: string } | null;
let status: string;
let executionState: IssueExecutionState | null;
let activity: Partial<ActivityEvent>[];
let failAt: string | null;
let calls: string[];
let lastPatch: Record<string, unknown> | null;
let requestRunId: string;
let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
const ctx = (issueId = "original") => ({
  runId: "22222222-2222-4222-8222-222222222222", agent: { id: "seat" }, context: { issueId },
  authToken: "scoped-test", onLog: vi.fn(),
} as unknown as AdapterExecutionContext);

beforeEach(async () => {
  dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/f07-settlement-");
  activePath = path.join(dir, "active.json");
  await fs.writeFile(activePath, JSON.stringify({ runId: sourceRunId, issueId: "original", rcUrl: "https://claude.ai/code/original",
    receiptPath: receiptFilePath(dir, sourceRunId) }));
  await fs.writeFile(receiptFilePath(dir, sourceRunId), JSON.stringify(receipt));
  report = null; status = "in_progress"; executionState = null; activity = []; failAt = null; calls = []; requestRunId = ctx().runId;
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname;
    const call = `${init.method} ${route}`;
    calls.push(call);
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(requestRunId);
    if (failAt === call) throw new Error("simulated process/transport interruption");
    if (route.endsWith("/activity")) return Response.json(activity);
    if (route === "/api/agents/seat/wakeup") return Response.json({ status: "queued" }, { status: 202 });
    if (route.endsWith("/documents/report")) {
      if (init.method === "PUT") {
        report = { body: JSON.parse(init.body as string).body, latestRevisionId: "revision" };
        return Response.json(report);
      }
      return report ? Response.json(report) : Response.json({ error: "absent" }, { status: 404 });
    }
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body as string);
      lastPatch = body;
      status = body.status;
      if (executionState?.status === "pending") {
        expect(body.comment).toContain(receipt.summary);
        expect(body.comment).toContain(sourceRunId);
        expect(body.comment).toContain(executionState.currentStageId);
        const previous = structuredClone(executionState);
        executionState = { ...executionState, status: "completed", currentStageId: null,
          currentStageType: null, currentParticipant: null,
          completedStageIds: [...executionState.completedStageIds, executionState.currentStageId!],
          lastDecisionId: "decision", lastDecisionOutcome: "approved" };
        activity.push({ action: "issue.updated", entityType: "issue", entityId: "original", actorType: "agent",
          actorId: "seat", agentId: "seat", runId: ctx().runId,
          details: { executionState, changes: { executionState: { from: previous, to: executionState } } } });
      }
    }
    return Response.json({ id: "original", status, assigneeAgentId: "seat", executionState });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // Synthetic state only; original owner records never enter this fixture.
  await fs.rm(dir, { recursive: true, force: true });
});

const retained = async () => expect(await fs.readFile(activePath, "utf8")).toContain(sourceRunId);
const noForeignDelivery = () => expect(calls.every(call => call === "POST /api/agents/seat/wakeup")).toBe(true);

function assignedReview(stageType: "review" | "approval" = "review") {
  status = "in_review";
  executionState = { status: "pending", currentStageId: "review", currentStageIndex: 0,
    currentStageType: stageType, currentParticipant: { type: "agent", agentId: "seat" },
    returnAssignee: { type: "agent", agentId: "worker" }, reviewRequest: null,
    completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
}

function nextReviewStage() {
  status = "in_review";
  executionState = { ...executionState!, status: "pending", currentStageId: "next-review", currentStageIndex: 1,
    currentStageType: "approval", currentParticipant: { type: "agent", agentId: "seat" } };
  const details = activity.at(-1)!.details!;
  details.executionState = executionState;
  (details.changes as { executionState: { to: IssueExecutionState } }).executionState.to = executionState;
}

describe("F07 durable receipt settlement", () => {
  it.each(["review", "approval"] as const)("submits the assigned %s participant's first receipt once, even though the issue starts in review", async stageType => {
    assignedReview(stageType);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "done" });
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    expect(executionState).toMatchObject({ status: "completed", lastDecisionOutcome: "approved" });
  });
  it("repairs an old in-review marker that never attempted the reviewer's decision", async () => {
    assignedReview();
    report = { body: receipt.report, latestRevisionId: "revision" };
    await fs.writeFile(path.join(dir, `settled-${sourceRunId}.json`), JSON.stringify({ version: 1,
      agentId: "seat", runId: sourceRunId, issueId: "original", outcome,
      fingerprint: createHash("sha256").update(JSON.stringify(outcome)).digest("hex"),
      status: "in_review", reportRevisionId: "revision" }));
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "done" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });
  it("verifies the actual policy transition and activity change contract", async () => {
    const reviewer = sourceRunId;
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewer }] },
    ] })!;
    assignedReview();
    executionState = { ...executionState!, currentStageId: policy.stages[0].id,
      currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: ctx().runId } };
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (new URL(url).pathname !== "/api/issues/original") return handler(url, init);
      calls.push(`${init.method} /api/issues/original`);
      const issue = { status, assigneeAgentId: reviewer, executionPolicy: policy, executionState };
      if (init.method !== "PATCH") return Response.json(issue);
      const body = JSON.parse(init.body as string);
      const transition = applyIssueExecutionPolicyTransition({ issue, policy, requestedStatus: body.status,
        requestedAssigneePatch: {}, actor: { agentId: reviewer }, commentBody: body.comment });
      expect(transition.decision).toMatchObject({ stageId: policy.stages[0].id, outcome: "approved", body: body.comment });
      executionState = { ...transition.patch.executionState as IssueExecutionState, lastDecisionId: ctx().runId };
      status = typeof transition.patch.status === "string" ? transition.patch.status : body.status;
      const updated = { ...issue, status, executionState };
      activity = [{ actorType: "agent", actorId: reviewer, agentId: reviewer, runId: ctx().runId,
        action: "issue.updated", entityType: "issue", entityId: "original",
        details: { ...transition.patch, executionState, changes: buildIssueChanges(issue, updated) } }];
      return Response.json(updated);
    });
    await expect(settleOutcome({ ...ctx(), agent: { ...ctx().agent, id: reviewer } }, dir, sourceRunId, "original", outcome))
      .resolves.toMatchObject({ status: "done", reviewDecisionId: ctx().runId });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });
  it.each(["participant", "assignee", "stage"])("retains a first review receipt without the current authorized %s", async mismatch => {
    assignedReview();
    if (mismatch === "participant") executionState!.currentParticipant = { type: "agent", agentId: "other" };
    if (mismatch === "stage") executionState!.currentStageId = null;
    const handler = fetchMock.getMockImplementation()!;
    if (mismatch === "assignee") fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      return new URL(url).pathname === "/api/issues/original"
        ? Response.json({ ...await response.json(), assigneeAgentId: "other" }) : response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("assigned current reviewer");
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(0);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
    await retained();
  });
  it.each(["transport", "", "{", "null", "{}"])("reconciles a stage-bound approval after lost/invalid acknowledgement %j without approving the next stage", async ack => {
    assignedReview();
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") {
        nextReviewStage(); // The same agent also owns the next stage.
        if (ack === "transport") throw new Error("lost approval acknowledgement");
        return new Response(ack);
      }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow();
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
    const recovery = { ...ctx(), runId: "recovery-run" };
    requestRunId = recovery.runId;
    await expect(settleOutcome(recovery, dir, sourceRunId, "original", outcome)).resolves.toMatchObject({
      status: "in_review", reviewDecisionId: "decision",
    });
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(true);
    await settleOutcome(recovery, dir, sourceRunId, "original", outcome);
    expect(executionState).toMatchObject({ currentStageId: "next-review", status: "pending" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    expect(calls.filter(c => c.startsWith("PUT"))).toHaveLength(1);
    await retained();
    status = "done";
    await settleOutcome(recovery, dir, sourceRunId, "original", outcome);
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });
  it.each(["missing", "run", "actor", "stage", "previousDecision", "outcome", "decisionId"])("does not infer a review decision from unrelated or incomplete %s evidence", async mismatch => {
    assignedReview();
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") {
        nextReviewStage();
        const event = activity[0];
        const change = (event.details!.changes as { executionState: { from: IssueExecutionState; to: IssueExecutionState } }).executionState;
        if (mismatch === "missing") activity = [];
        if (mismatch === "run") event.runId = sourceRunId;
        if (mismatch === "actor") event.actorId = "other";
        if (mismatch === "stage") change.from.currentStageId = "unrelated-stage";
        if (mismatch === "previousDecision") change.from.lastDecisionId = "unrelated-decision";
        if (mismatch === "outcome") change.to.lastDecisionOutcome = "changes_requested";
        if (mismatch === "decisionId") change.to.lastDecisionId = null;
        throw new Error("lost approval acknowledgement");
      }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("lost approval");
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("review decision not verified");
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
    await retained();
  });
  it("retains an attempted review whose acknowledgement did not record a decision", async () => {
    assignedReview();
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        calls.push("PATCH /api/issues/original");
        return Response.json({ status: "in_review", executionState });
      }
      return handler(url, init);
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("review decision not verified");
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("review decision not verified");
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(false);
  });
  it("retains a valid receipt written before delivery and requests only a scoped recovery", async () => {
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("previous task unresolved");
    await retained(); noForeignDelivery();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      payload: { issueId: "original" }, idempotencyKey: `claude-rc-settlement:${sourceRunId}`,
    });
  });
  it("never treats one-character JSON or a block terminal as settlement", async () => {
    await fs.writeFile(receiptFilePath(dir, sourceRunId), "{");
    await fs.mkdir(path.join(dir, "channel-bridge"));
    await fs.writeFile(path.join(dir, "channel-bridge/ledger.jsonl"), JSON.stringify({ ev: "terminal", kind: "block", op_id: sourceRunId }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("previous task unresolved");
    await retained(); noForeignDelivery();
  });
  it("finishes report-before-status recovery without publishing a second report revision", async () => {
    failAt = "GET /api/issues/original";
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("interruption");
    expect(report?.body).toBe(receipt.report);
    await retained();
    failAt = null;
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PUT"))).toHaveLength(1);
    expect(status).toBe("done");
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("reconciles status persisted before acknowledgement/cleanup without repeating the transition", async () => {
    let loseAck = true;
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH" && loseAck) { loseAck = false; throw new Error("lost status acknowledgement"); }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("lost status");
    expect(status).toBe("done");
    // A foreign issue still cannot infer delivery from files/status it cannot reconcile.
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("archives a settled checkpoint after a cleanup crash without delivery or provider replay", async () => {
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    calls = [];
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    expect(calls).toEqual([]);
    expect(await fs.readFile(path.join(dir, `active.settled-${sourceRunId}.json`), "utf8")).toContain(sourceRunId);
  });
  it("retains malformed/mismatched markers and a receipt replaced after delivery", async () => {
    await fs.writeFile(path.join(dir, `settled-${sourceRunId}.json`), "{");
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    await fs.writeFile(receiptFilePath(dir, sourceRunId), JSON.stringify({ ...receipt, report: receipt.report + "changed" }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
  });
  it("does not mutate another issue even with a syntactically valid receipt", async () => {
    await expect(settleOutcome(ctx("next"), dir, sourceRunId, "original", outcome)).rejects.toThrow("original issue scope");
    expect(calls).toEqual([]); await retained();
  });
  it("retains original work if recovery scheduling is denied", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
  });
  it("retains failed authenticated delivery and does not mark it settled", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("HTTP 403");
    await retained();
    await expect(fs.stat(path.join(dir, `settled-${sourceRunId}.json`))).rejects.toThrow();
  });
  it("does not mistake a successful review-stage PATCH for done or replay it", async () => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") status = "in_review";
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(true);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", { ...receipt, report: receipt.report + "changed" })).toBe(false);
    expect(await isReviewContinuation(ctx("next"), dir, sourceRunId, "next", receipt)).toBe(false);
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await retained();
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
    status = "done"; // The real reviewer, rather than the delivery retry, finished review.
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "done" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("preserves legacy worker-to-review continuation with its matching durable transition intent", async () => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") status = "in_review";
      return response;
    });
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    const file = path.join(dir, `settling-${sourceRunId}.json`);
    const { agentId: _agent, deliveryRunId: _run, ...legacy } = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify(legacy));
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(true);
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });
  it("keeps same-issue adoption on the existing operation", async () => {
    await reconcileForeignSettlement(ctx(), dir, activePath);
    await retained(); expect(calls).toEqual([]);
  });

  it.each(["", "{", "null", "{}"])("retains an invalid status acknowledgement and recovers review without repeating PATCH: %j", async body => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") { status = "in_review"; return new Response(body); }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow();
    await retained();
    await expect(fs.stat(path.join(dir, `settled-${sourceRunId}.json`))).rejects.toThrow();
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });

  it.each(["", "{", "null", "{}"])("rejects an invalid report success acknowledgement: %j", async body => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      init.method === "PUT" ? new Response(body) : handler(url, init));
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow();
    await retained();
    expect(calls.some(c => c.startsWith("PATCH"))).toBe(false);
  });
  it("requires verified blocked delivery before releasing a foreign block terminal", async () => {
    await settleOutcome(ctx(), dir, sourceRunId, "original", { kind: "block", reason: "Missing input" });
    expect(status).toBe("blocked");
    expect(lastPatch?.unblockDescriptor).toMatchObject({ owner: "board" });
    calls = [];
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    expect(calls).toEqual([]);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
});
