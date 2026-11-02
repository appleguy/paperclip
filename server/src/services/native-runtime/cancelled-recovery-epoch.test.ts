import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../vendor/paperclip-runner/index.js", async (original) => ({
  ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(),
  retainedRunnerdCleanupProofIsCurrent: (proof: { current?: boolean }) => proof?.current === true,
}));
import { cancelledBridgeSettlementDigest, consumePreparedCancelledIntent, exactCancelledOwner as owner } from "./cancelled-retained-cleanup-authority.js";
import { nativeSha256 } from "./canonical.js";
import { cancelledResumeLineageIsAuthentic, createCancelledRecoveryEpochReaderForTest, readCancelledRecoveryEpoch } from "./cancelled-recovery-epoch.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const intentRoot = mkdtempSync(join(tmpdir(), "cancelled-epoch-")); roots.push(intentRoot);
  const boardRequestId = "11111111-1111-4111-8111-111111111111", requestId = "native-cleanup:fixture";
  const stagedDirectory = join(dirname(owner.stateDirectory), `${basename(owner.stateDirectory)}.cleanup-fixture`);
  const identity = { runnerInstanceId: owner.runnerInstanceId, environmentLeaseId: owner.environmentLeaseId,
    runId: owner.runId, normalizedSessionId: owner.nativeSessionId, turnId: "turn", itemId: "item" };
  const calls = ["read", "write"].map((id) => ({ callId: id, operationId: "call_api",
    input: { operationId: id === "read" ? "GET /x" : "POST /x" } }));
  const fullPlan = calls.map((call, index) => ({ callId: call.callId, operationId: call.operationId,
    inputDigest: nativeSha256(call.input), disposition: index ? "completed_api_receipt" as const : "read_cancelled" as const,
    result: index ? { id: "saved" } : { error: "cancelled" }, isError: !index }));
  const payload = (index: number) => ({callId: calls[index]!.callId, operationId: "call_api",
    result: fullPlan[index]!.result, isError: fullPlan[index]!.isError});
  const command = (index: number, status: string) => {
    const commandId = `command_reconcile_${createHash("sha256").update(`${requestId}\0${calls[index]!.callId}`).digest("hex")}`;
    const controllerSeq = index + 1;
    return { type: "semantic_tool.result", status, commandId, controllerSeq, payload: payload(index),
      result: status === "completed" ? { commandId, commandType: "semantic_tool.result", controllerSeq,
        status: "completed", result: { status: "settled_after_turn", callId: calls[index]!.callId } } : null };
  };
  const completed = command(0, "completed");
  const original = { fingerprint: owner.sourceFingerprint, control: { identity }, runner: identity,
    provider: { toolBridge: { pending: Object.fromEntries(calls.map((call) => [call.callId, call])) } } };
  const staged = { fingerprint: "a".repeat(64), control: { identity, commands: [completed, command(1, "pending")] },
    runner: { ...identity, processedCommands: { [completed.commandId]: completed.result } }, provider: { threadId: owner.providerSessionId, lifecycle: "closed", toolBridge: {
      turnClosed: true, pending: { write: calls[1] }, settledResults: { read: { call: calls[0], result: payload(0) } },
    } } };
  const common = { kind: "native_cleanup_runner_epoch", version: 1, schema: "paperclip.native_cleanup_runner_epoch.v1",
    requestId, epoch: 0, stateDirectory: stagedDirectory, launchId: "launch", initialFingerprint: "b".repeat(64),
    runnerArtifact: { path: "/runner", version: "v", digest: "digest" } };
  const process = { pid: 1234, processGroupId: 1234, processStartedAt: "start", spawnedAt: "spawn" };
  const history: Record<string, unknown>[] = [
    { kind: "native_cleanup_board_authorization", version: 1, requestId: boardRequestId,
      requestLease: requestId, sourceFingerprint: owner.sourceFingerprint, reconciledToolCallsDigest: cancelledBridgeSettlementDigest(fullPlan) },
    { kind: "native_cleanup_maintenance", version: 1, phase: "started", requestId, sourceFingerprint: owner.sourceFingerprint },
    { kind: "native_cleanup_maintenance", version: 1, phase: "staged", requestId, sourceFingerprint: owner.sourceFingerprint, stagingName: basename(stagedDirectory) },
    { ...common, phase: "launch_intent" }, { ...common, ...process, phase: "spawned" },
    { ...common, ...process, phase: "retired", processGroupAbsent: true, retiredAt: "retired", finalFingerprint: staged.fingerprint },
  ];
  writeFileSync(join(intentRoot, `${owner.runId}.json.started`), JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1",
    status: "prepared", requestId: boardRequestId, runId: owner.runId, nativeSessionId: owner.nativeSessionId,
    runnerInstanceId: owner.runnerInstanceId, originalFingerprint: owner.sourceFingerprint }), { mode: 0o600 });
  return { intentRoot, boardRequestId, history, original, staged, stagedDirectory, fullPlan };
}

it("reuses only the exact retired epoch and fresh remaining receipt", () => {
  const f = fixture();
  const result = readCancelledRecoveryEpoch(f);
  expect(result?.semanticToolResults).toEqual([f.fullPlan[1]]);
  expect(result?.priorRetiredEpoch).toEqual(f.history[5]);
  expect(result?.originalFingerprint).toBe(owner.sourceFingerprint);
  expect(result?.fullPlanDigest).toBe(cancelledBridgeSettlementDigest(f.fullPlan));
  expect(result).not.toHaveProperty("settledProof");
  expect(result).not.toHaveProperty("settledFingerprint");
  expect(cancelledResumeLineageIsAuthentic(result!)).toBe(true);
  expect(cancelledResumeLineageIsAuthentic(structuredClone(result!))).toBe(false);
  result!.semanticToolResults[0]!.result = { id: "tampered" };
  expect(cancelledResumeLineageIsAuthentic(result!)).toBe(false);
});

it("limits the synthetic owner reader to tests and keeps its owner bound", () => {
  const f = fixture();
  const synthetic = { ...owner, stateDirectory: String(owner.stateDirectory) };
  const read = createCancelledRecoveryEpochReaderForTest(synthetic);
  synthetic.stateDirectory = "/foreign";
  expect(read(f)).not.toBeNull();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    expect(() => createCancelledRecoveryEpochReaderForTest(owner)).toThrow("test-only");
  } finally { process.env.NODE_ENV = previous; }
});

it("rejects changed intent, lineage, receipt, journal, identity, revision and process", () => {
  const f = fixture();
  const variants = [
    { ...f, boardRequestId: "foreign" },
    { ...f, stagedDirectory: `${f.stagedDirectory}-foreign` },
    { ...f, original: { ...f.original, fingerprint: "bad" } },
    { ...f, staged: { ...f.staged, fingerprint: "bad" } },
    { ...f, fullPlan: [f.fullPlan[0]!, { ...f.fullPlan[1]!, result: { id: "changed" } }] },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, identity: { ...f.staged.control.identity, turnId: "foreign" } } } },
    { ...f, history: f.history.map((e, i) => i === 5 ? { ...e, pid: 999 } : e) },
    { ...f, history: f.history.map((e, i) => i === 5 ? { ...e, requestId: "native-cleanup:stale" } : e) },
    { ...f, history: f.history.map((e, i) => i === 5 ? { ...e, finalFingerprint: "f".repeat(64) } : e) },
    { ...f, history: f.history.map((e, i) => i === 5 ? { ...e, stateDirectory: `${f.stagedDirectory}-foreign` } : e) },
    { ...f, history: f.history.map((e, i) => i === 0 ? { ...e, reconciledToolCallsDigest: "f".repeat(64) } : e) },
    { ...f, history: f.history.map((e, i) => i === 5 ? { ...e, processGroupAbsent: false } : e) },
    { ...f, history: [...f.history, f.history[5]!] },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [f.staged.control.commands[0],
      { ...f.staged.control.commands[1], commandId: "foreign" }] } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [...f.staged.control.commands,
      { type: "turn.start", status: "pending", payload: {} }] } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [...f.staged.control.commands,
      f.staged.control.commands[1]] } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [
      { ...f.staged.control.commands[0], payload: { ...f.staged.control.commands[0]!.payload, result: { error: "changed" } } },
      f.staged.control.commands[1]] } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [
      { ...f.staged.control.commands[0], status: "failed" }, f.staged.control.commands[1]] } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [f.staged.control.commands[1]] } } },
    { ...f, staged: { ...f.staged, runner: { ...f.staged.runner, processedCommands: {} } } },
    { ...f, staged: { ...f.staged, control: { ...f.staged.control, commands: [
      { ...f.staged.control.commands[0], result: { ...f.staged.control.commands[0]!.result, status: "failed" } },
      f.staged.control.commands[1]] } } },
  ];
  for (const variant of variants) expect(readCancelledRecoveryEpoch(variant)).toBeNull();
});

it("rejects an altered or consumed Board intent", () => {
  const f = fixture();
  const path = join(f.intentRoot, `${owner.runId}.json.started`);
  writeFileSync(path, JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1", status: "prepared",
    requestId: f.boardRequestId, runId: owner.runId, nativeSessionId: owner.nativeSessionId,
    runnerInstanceId: "foreign", originalFingerprint: owner.sourceFingerprint }));
  expect(readCancelledRecoveryEpoch(f)).toBeNull();
  const fresh = fixture();
  writeFileSync(join(fresh.intentRoot, `${owner.runId}.json.used`), "consumed", { mode: 0o600 });
  expect(readCancelledRecoveryEpoch(fresh)).toBeNull();
});

it("consumes only a current in-process proof joined to authentic resume lineage", () => {
  const f = fixture(); const lineage = readCancelledRecoveryEpoch(f)!;
  const proof = { current: true, binding: { companyId: owner.companyId, agentId: owner.agentId,
    issueId: owner.issueId, runId: owner.runId, sessionId: owner.nativeSessionId },
    identity: { runnerInstanceId: owner.runnerInstanceId }, backend: { kind: "runner", name: "codex_app_server" },
    providerSessionId: owner.providerSessionId, activationDirectory: owner.stateDirectory, sourceFingerprint: f.staged.fingerprint,
    stagedSourceFingerprint: f.staged.fingerprint,
    reconciledToolCallsDigest: cancelledBridgeSettlementDigest(lineage.semanticToolResults) };
  const input = { root: f.intentRoot, runId: owner.runId, requestId: f.boardRequestId,
    originalFingerprint: owner.sourceFingerprint, expectedReconciledToolCallsDigest: lineage.fullPlanDigest,
    settledProof: proof as never, resumeLineage: lineage };
  expect(consumePreparedCancelledIntent({ ...input, resumeLineage: structuredClone(lineage) })).toBe(false);
  expect(consumePreparedCancelledIntent({ ...input, settledProof: { ...proof, current: false } as never })).toBe(false);
  expect(consumePreparedCancelledIntent({ ...input, settledProof: { ...proof, activationDirectory: "/foreign" } as never })).toBe(false);
  expect(consumePreparedCancelledIntent({ ...input, settledProof: { ...proof, sourceFingerprint: "bad" } as never })).toBe(false);
  expect(consumePreparedCancelledIntent({ ...input, expectedReconciledToolCallsDigest: "f".repeat(64) })).toBe(false);
  expect(consumePreparedCancelledIntent(input)).toBe(true);
  expect(consumePreparedCancelledIntent(input)).toBe(false);
});
