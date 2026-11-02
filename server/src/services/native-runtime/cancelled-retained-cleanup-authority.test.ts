import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>(),
  retainedRunnerdCleanupProofIsCurrent: (proof: { current?: boolean }) => proof?.current === true,
}));

import { buildCancelledBridgeSettlementPlan, cancelledBridgeSettlementDigest, classifyCancelledBridgeReceipts, consumePreparedCancelledIntent, createCancelledCleanupAuthorityForTest, exactCancelledCleanupJournalMatches, exactCancelledClosedActivationMatches, exactCancelledOwner, exactOwnerIdentityMatches, reservePreparedCancelledIntent } from "./cancelled-retained-cleanup-authority.js";
import { nativeSha256 } from "./canonical.js";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("cancelled retained cleanup authority", () => {
  it("isolates a synthetic test owner from the frozen production singleton", () => {
    const synthetic = { ...exactCancelledOwner, runId: "synthetic-run" };
    const authority = createCancelledCleanupAuthorityForTest(synthetic);
    const run = { id: synthetic.runId, companyId: synthetic.companyId, agentId: synthetic.agentId,
      nativeIssueId: synthetic.issueId, nativeSessionId: synthetic.nativeSessionId,
      runnerInstanceId: synthetic.runnerInstanceId, status: "cancelled", errorCode: "native_session_interrupted",
      runtimeMode: "native", processPid: null, processGroupId: null };
    expect(authority.exactOwnerIdentityMatches(run)).toBe(true);
    expect(exactOwnerIdentityMatches(run)).toBe(false);
    expect(Object.isFrozen(exactCancelledOwner)).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    try { expect(() => createCancelledCleanupAuthorityForTest(synthetic)).toThrow("test-only"); }
    finally { vi.unstubAllEnvs(); }
  });
  it("binds cancellation journal events to the accepted result and rejects tampering", () => {
    const o = exactCancelledOwner;
    const identity = { runId: o.runId, normalizedSessionId: o.nativeSessionId,
      runnerInstanceId: o.runnerInstanceId, environmentLeaseId: o.environmentLeaseId, turnId: "turn", itemId: "item" };
    const event = (eventType: string, sourceSeq: number, payload: unknown) => ({
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq, priority: 1,
      emittedAt: new Date().toISOString(), turnId: identity.turnId, itemId: identity.itemId,
      sourceEventId: `${o.runnerInstanceId}:${o.runId}:${sourceSeq}`, sourceInstanceId: o.runnerInstanceId,
      runId: o.runId, normalizedSessionId: o.nativeSessionId, eventType, payload,
    });
    const result = { schema: "paperclip.run_result.v1", summary: "cancelled", reportedWorkDisposition: "needs_review",
      completionClaim: { contractRevision: "1", criteria: [{ criterionId: "objective", evidenceRefs: [], status: "unknown" }],
        objectiveSatisfied: false, remainingWork: [{ blocksCompletion: true, description: "Review the stopped run." }] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted",
      runTerminalState: "cancelled", reportedWorkDisposition: "needs_review" };
    const accepted = { schemaStatus: "accepted", resultJson: { result, terminal }, turnId: "provider-turn",
      canonicalSha256: `sha256:${nativeSha256({ result, terminal, turnId: "provider-turn" })}`, serverFingerprint: "" };
    accepted.serverFingerprint = `sha256:${nativeSha256({ runId: o.runId, completionContractSha256: "sha", canonicalSha256: accepted.canonicalSha256 })}`;
    const started = event("session.started", 1, { driverSessionId: o.providerSessionId, providerSessionId: o.providerSessionId, context: {} });
    const events = [event("turn.accepted", 2, { providerSessionId: o.providerSessionId, providerTurnId: "provider-turn" }),
      event("run.result.proposed", 3, result), event("turn.interrupted", 4, { status: "interrupted", providerTurnId: "provider-turn" }),
      event("run.terminal", 5, { ...terminal, provider: "codex" })];
    const input = { run: { id: o.runId, companyId: o.companyId, agentId: o.agentId, nativeIssueId: o.issueId,
      nativeSessionId: o.nativeSessionId, runnerInstanceId: o.runnerInstanceId, status: "cancelled",
      errorCode: "native_session_interrupted", runtimeMode: "native", processPid: null, processGroupId: null,
      completionContractId: "contract", completionContractSha256: "sha" },
      execution: { binding: { companyId: o.companyId, agentId: o.agentId, issueId: o.issueId, runId: o.runId },
        completionContract: { contract: { revision: "1", criteria: [{ id: "objective" }] } } } as never,
      accepted, providerSessionId: o.providerSessionId,
      persistedEvents: [{ eventType: started.eventType, payload: { prpEvent: started }, sourceInstanceId: o.runnerInstanceId,
        sourceEventId: started.sourceEventId, sourceSeq: started.sourceSeq, sourcePayloadSha256: nativeSha256(started) }],
      control: { identity, commands: [{ type: "run.prepare", status: "completed", payload: { completionContract: { revision: "1", criterionIds: ["objective"] } } },
        { type: "turn.start", status: "completed", result: { result: { providerTurnId: "provider-turn" } } }],
        committedEvents: events.map(e => ({ envelope: { payload: e } })) } };
    expect([started, ...events].map(validatePrpEvent)).toEqual(Array(5).fill(expect.objectContaining({ ok: true })));
    expect(exactCancelledCleanupJournalMatches(input)).toBe(true);
    for (const payload of [{ ...terminal, provider: "other" }, terminal, { ...terminal, provider: "codex", extra: true }]) {
      const changed = [...events.slice(0, 3), event("run.terminal", 5, payload)];
      expect(exactCancelledCleanupJournalMatches({ ...input, control: { ...input.control,
        committedEvents: changed.map(e => ({ envelope: { payload: e } })) } })).toBe(false);
    }
    expect(exactCancelledCleanupJournalMatches({ ...input, accepted: { ...accepted, serverFingerprint: "wrong" } })).toBe(false);
    expect(exactCancelledCleanupJournalMatches({ ...input, providerSessionId: "foreign" })).toBe(false);
    expect(exactCancelledCleanupJournalMatches({ ...input, control: { ...input.control, committedEvents: events.slice(0, 3).map(e => ({ envelope: { payload: e } })) } })).toBe(false);
  });
  it("consumes an in-process proof once only when its digest matches the derived plan", () => {
    const root = mkdtempSync(join(tmpdir(), "cancelled-intent-test-"));
    const o = exactCancelledOwner;
    const requestId = "a1e52d6f-4d43-4db8-a7af-99f010001111";
    const path = join(root, o.runId + ".json");
    const plan = [{ callId: "read", operationId: "call_api", inputDigest: "0".repeat(64),
      disposition: "read_cancelled" as const, result: { ok: false }, isError: true }];
    const digest = cancelledBridgeSettlementDigest(plan);
    const proof = { current: true, binding: { companyId: o.companyId, agentId: o.agentId,
      issueId: o.issueId, runId: o.runId, sessionId: o.nativeSessionId },
      identity: { runnerInstanceId: o.runnerInstanceId }, backend: { kind: "runner", name: "codex_app_server" },
      providerSessionId: o.providerSessionId, activationDirectory: o.stateDirectory, sourceFingerprint: o.sourceFingerprint,
      stagedSourceFingerprint: o.sourceFingerprint, reconciledToolCallsDigest: digest };
    try {
      writeFileSync(path, JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1", requestId,
        runId: o.runId, nativeSessionId: o.nativeSessionId, runnerInstanceId: o.runnerInstanceId,
        originalFingerprint: o.sourceFingerprint, status: "prepared" }), { mode: 0o600 });
      expect(reservePreparedCancelledIntent({ root, requestId })).toBe(true);
      const args = { root, requestId, runId: o.runId, originalFingerprint: o.sourceFingerprint,
        expectedReconciledToolCallsDigest: digest, settledProof: proof as never };
      expect(consumePreparedCancelledIntent({ ...args, expectedReconciledToolCallsDigest: "f".repeat(64) })).toBe(false);
      expect(consumePreparedCancelledIntent(args)).toBe(true);
      expect(consumePreparedCancelledIntent(args)).toBe(false);
      expect(JSON.parse(readFileSync(path + ".used", "utf8")).requestId).toBe(requestId);
      expect(() => cancelledBridgeSettlementDigest([{ ...plan[0]!, result: [undefined] }])).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("admits a closed activation only for matching original identity and settled receipt", () => {
    const o = exactCancelledOwner;
    const marker = { companyId: o.companyId, issueId: o.issueId, runId: o.runId,
      nativeSessionId: o.nativeSessionId, runnerInstanceId: o.runnerInstanceId,
      providerSessionId: o.providerSessionId, requestId: "native-cleanup:test",
      sourceFingerprint: o.sourceFingerprint, stagedSourceFingerprint: o.sourceFingerprint,
      settledFingerprint: "b".repeat(64), reconciledToolCallsDigest: "a".repeat(64) };
    const receipt = { ...marker, phase: "settled" };
    const runner = { runId: o.runId, normalizedSessionId: o.nativeSessionId,
      runnerInstanceId: o.runnerInstanceId, lifecycle: "suspended" };
    const provider = { threadId: o.providerSessionId, lifecycle: "closed", toolBridge: { turnClosed: true, pending: {} } };
    expect(exactCancelledClosedActivationMatches(marker, receipt, runner, provider)).toBe(true);
    const resume = { resumedFromFingerprint: "c".repeat(64), resumedToolCallsDigest: "d".repeat(64), resumedFromRequestId: "native-cleanup:prior" };
    expect(exactCancelledClosedActivationMatches({ ...marker, ...resume }, { ...receipt, ...resume }, runner, provider)).toBe(true);
    expect(exactCancelledClosedActivationMatches({ ...marker, ...resume }, { ...receipt, ...resume, resumedToolCallsDigest: "e".repeat(64) }, runner, provider)).toBe(false);
    expect(exactCancelledClosedActivationMatches(marker, { ...receipt, phase: "activation_prepared" }, runner, provider)).toBe(false);
    expect(exactCancelledClosedActivationMatches(marker, { ...receipt, reconciledToolCallsDigest: "c".repeat(64) }, runner, provider)).toBe(false);
    expect(exactCancelledClosedActivationMatches({ ...marker, sourceFingerprint: "0".repeat(64) }, receipt, runner, provider)).toBe(false);
    expect(exactCancelledClosedActivationMatches(marker, receipt, runner, { ...provider, toolBridge: { turnClosed: true, pending: { x: {} } } })).toBe(false);
  });
  it("durably reserves a single attempt and refuses replay after interruption", () => {
    const root = mkdtempSync(join(tmpdir(), "cancelled-intent-test-"));
    const o = exactCancelledOwner;
    const requestId = "a1e52d6f-4d43-4db8-a7af-99f010001111";
    const path = join(root, o.runId + ".json");
    try {
      writeFileSync(path, JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1", requestId,
        runId: o.runId, nativeSessionId: o.nativeSessionId, runnerInstanceId: o.runnerInstanceId,
        originalFingerprint: o.sourceFingerprint, status: "prepared" }), { mode: 0o600 });
      expect(reservePreparedCancelledIntent({ root, requestId: "wrong" })).toBe(false);
      expect(reservePreparedCancelledIntent({ root, requestId })).toBe(true);
      expect(JSON.parse(readFileSync(path + ".started", "utf8")).requestId).toBe(requestId);
      expect(reservePreparedCancelledIntent({ root, requestId })).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses reservation when a crash left both prepared and started links", () => {
    const root = mkdtempSync(join(tmpdir(), "cancelled-intent-test-"));
    const o = exactCancelledOwner;
    const requestId = "a1e52d6f-4d43-4db8-a7af-99f010001111";
    const path = join(root, o.runId + ".json");
    try {
      writeFileSync(path, JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1", requestId,
        runId: o.runId, nativeSessionId: o.nativeSessionId, runnerInstanceId: o.runnerInstanceId,
        originalFingerprint: o.sourceFingerprint, status: "prepared" }), { mode: 0o600 });
      linkSync(path, path + ".started");
      expect(reservePreparedCancelledIntent({ root, requestId })).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("binds the exact cancelled run and rejects changed ownership", () => {
    const o = exactCancelledOwner;
    const run = { id: o.runId, companyId: o.companyId, agentId: o.agentId,
      nativeIssueId: o.issueId, nativeSessionId: o.nativeSessionId,
      runnerInstanceId: o.runnerInstanceId, status: "cancelled",
      errorCode: "native_session_interrupted", runtimeMode: "native",
      processPid: null, processGroupId: null };
    expect(exactOwnerIdentityMatches(run)).toBe(true);
    expect(exactOwnerIdentityMatches({ ...run, status: "failed" })).toBe(false);
    expect(exactOwnerIdentityMatches({ ...run, processPid: 99 })).toBe(false);
    expect(exactOwnerIdentityMatches({ ...run, nativeSessionId: "other" })).toBe(false);
  });

  it("derives read cancellation and the exact completed mutation result without executing either", async () => {
    const input = { operationId: "PUT /api/test", body: { value: 1 } };
    const pending = {
      read: { callId: "read", operationId: "call_api", input: { operationId: "GET /api/test" } },
      write: { callId: "write", operationId: "call_api", input },
    };
    const digest = sha('{"body":{"value":1},"operationId":"PUT /api/test"}');
    const receipts = { [sha("write")]: { state: "completed", operationId: input.operationId, digest,
      result: { ok: true, operationId: input.operationId } } };
    expect(classifyCancelledBridgeReceipts(pending, receipts)).toMatchObject({
      readOnlyPending: 1, mutationsWithCompletedExactReceipts: 1, allSideEffectsReconciled: true,
    });
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: receipts })).resolves.toEqual([
      expect.objectContaining({ callId: "read", disposition: "read_cancelled", isError: true }),
      expect.objectContaining({ callId: "write", inputDigest: digest, disposition: "completed_api_receipt", isError: false }),
    ]);
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: {
      [sha("write")]: { ...receipts[sha("write")], digest: "0".repeat(64) },
    } })).resolves.toBeNull();
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: {} })).resolves.toBeNull();
  });

  it("rejects an encrypted receipt unless it resolves to a known outcome", async () => {
    const input = { operationId: "DELETE /api/test" };
    const pending = { write: { callId: "write", operationId: "call_api", input } };
    const receipt = { [sha("write")]: { state: "completed", operationId: input.operationId,
      digest: sha('{"operationId":"DELETE /api/test"}'), encryptedResult: { opaque: true } } };
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: receipt })).resolves.toBeNull();
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: receipt,
      resolveEncryptedResult: async () => ({ outcome: "unknown" }) })).resolves.toBeNull();
    await expect(buildCancelledBridgeSettlementPlan({ pending, apiToolReceipts: receipt,
      resolveEncryptedResult: async () => ({ ok: true }) })).resolves.toHaveLength(1);
  });
});
