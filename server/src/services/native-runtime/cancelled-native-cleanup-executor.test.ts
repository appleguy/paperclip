import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import requestHttp from "supertest";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { readCancelledRecoveryEpoch } from "./cancelled-recovery-epoch.js";

const fixture = vi.hoisted(() => ({ enabled: false, owner: {} as Record<string, unknown>, settle: vi.fn(), complete: vi.fn(), decrypt: vi.fn(), audit: vi.fn() }));
vi.mock("./cancelled-retained-cleanup-authority.js", async (original) => {
  const actual = await original<typeof import("./cancelled-retained-cleanup-authority.js")>();
  Object.assign(fixture.owner, actual.exactCancelledOwner);
  const bound = () => actual.createCancelledCleanupAuthorityForTest(fixture.owner as unknown as typeof actual.exactCancelledOwner);
  return { ...actual, exactCancelledOwner: fixture.owner,
    assessCancelledNativeOwner: (...args: Parameters<typeof actual.assessCancelledNativeOwner>) => fixture.enabled ? bound().assessCancelledNativeOwner(...args) : actual.assessCancelledNativeOwner(...args),
    exactCancelledCleanupJournalMatches: (...args: Parameters<typeof actual.exactCancelledCleanupJournalMatches>) => fixture.enabled ? bound().exactCancelledCleanupJournalMatches(...args) : actual.exactCancelledCleanupJournalMatches(...args),
    prepareExactCancelledRecoveryIntent: (...args: Parameters<typeof actual.prepareExactCancelledRecoveryIntent>) => fixture.enabled ? bound().prepareExactCancelledRecoveryIntent(...args) : actual.prepareExactCancelledRecoveryIntent(...args),
    reservePreparedCancelledIntent: (...args: Parameters<typeof actual.reservePreparedCancelledIntent>) => fixture.enabled ? bound().reservePreparedCancelledIntent(...args) : actual.reservePreparedCancelledIntent(...args),
    consumePreparedCancelledIntent: (...args: Parameters<typeof actual.consumePreparedCancelledIntent>) => fixture.enabled ? bound().consumePreparedCancelledIntent(...args) : actual.consumePreparedCancelledIntent(...args),
  };
});
vi.mock("../native-finalization-notifications.js", () => ({ notifyNativeFinalizationWork: async () => undefined }));
vi.mock("../activity-log.js", async original => ({ ...await original<typeof import("../activity-log.js")>(), logActivity: fixture.audit }));
vi.mock("../../vendor/paperclip-runner/index.js", async (original) => {
  const actual = await original<typeof import("../../vendor/paperclip-runner/index.js")>();
  return { ...actual, settleRetainedRunnerdSession: fixture.settle,
    completeRetainedNativeSessionCleanup: fixture.complete,
    retainedRunnerdCleanupProofIsCurrent: (proof: unknown) => fixture.enabled ? true : actual.retainedRunnerdCleanupProofIsCurrent(proof as never),
    drainRetainedRunnerdMaintenanceOperations: async () => undefined };
});
vi.mock("../../secrets/provider-registry.js", async (original) => {
  const actual = await original<typeof import("../../secrets/provider-registry.js")>();
  return { ...actual, getSecretProvider: (...args: Parameters<typeof actual.getSecretProvider>) => fixture.enabled
    ? { resolveVersion: fixture.decrypt } : actual.getSecretProvider(...args) };
});
import { cancelledBridgeSettlementDigest, createCancelledCleanupAuthorityForTest, exactCancelledOwner as owner } from "./cancelled-retained-cleanup-authority.js";
import { reconcileCancelledRetainedNativeSessionCleanup as reconcile } from "./native-session-executor.js";
import { cancelledNativeCleanupRoutes } from "../../routes/cancelled-native-cleanup.js";
import { errorHandler } from "../../middleware/error-handler.js";

const request = { companyId: owner.companyId, runId: owner.runId,
  expectedFingerprint: owner.sourceFingerprint, actorId: "board-user",
  requestId: "a1e52d6f-4d43-4db8-a7af-99f010001111" };

function database(row: Record<string, unknown> | null) {
  const update = vi.fn();
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const chain = { from: () => chain, where: () => chain, for: () => chain,
      orderBy: () => chain, limit: async () => row ? [row] : [] };
    return fn({ select: () => chain, update });
  });
  return { db: { transaction } as unknown as Db, transaction, update };
}

describe("cancelled retained cleanup executor admission", () => {
  afterEach(() => vi.restoreAllMocks());
  it("rejects foreign owner, fingerprint, actor and request before touching the database", async () => {
    const fixture = database(null);
    for (const input of [
      { ...request, companyId: "foreign" }, { ...request, runId: "foreign" },
      { ...request, expectedFingerprint: "0".repeat(64) },
      { ...request, actorId: " " }, { ...request, requestId: "bad" },
    ]) expect((await reconcile(fixture.db, input)).status).toBe("not_eligible");
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
  it("leaves a foreign database owner untouched", async () => {
    const fixture = database({ id: owner.runId, companyId: owner.companyId,
      agentId: "foreign", nativeIssueId: owner.issueId, nativeSessionId: owner.nativeSessionId,
      runnerInstanceId: owner.runnerInstanceId, status: "cancelled", errorCode: "native_session_interrupted",
      runtimeMode: "native", processPid: 1, processGroupId: 1, finishedAt: new Date() });
    expect((await reconcile(fixture.db, request)).status).toBe("not_eligible");
    expect(fixture.update).not.toHaveBeenCalled();
  });
  it("retains the owner while its historical runner process is still live", async () => {
    const fixture = database({ id: owner.runId, companyId: owner.companyId,
      agentId: owner.agentId, nativeIssueId: owner.issueId, nativeSessionId: owner.nativeSessionId,
      runnerInstanceId: owner.runnerInstanceId, status: "cancelled", errorCode: "native_session_interrupted",
      runtimeMode: "native", processPid: null, processGroupId: null, processStartedAt: undefined, finishedAt: new Date() });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await reconcile(fixture.db, request)).toMatchObject({ status: "deferred", waitFor: "process_exit" });
    expect(kill).toHaveBeenCalledWith(owner.runnerPid, 0);
    expect(fixture.update).not.toHaveBeenCalled();
  });
});

describe("cancelled cleanup filesystem handoff", () => {
  it.each(["success", "board_route", "before_rename", "commit_failure", "unknown_receipt", "resume", "resume_bad_request", "resume_bad_receipt", "resume_bad_epoch", "resume_bad_runner_receipt"])("preserves original across %s", async (mode) => {
    const failCommit = mode === "commit_failure";
    const failBeforeRename = mode === "before_rename";
    const container = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/cancelled-cleanup-");
    const base = join(container, "durable-sessions"); mkdirSync(base, { mode: 0o700 });
    const oldOwner = { ...fixture.owner };
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    fixture.enabled = true;
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const canonical = (value: unknown): string => value && typeof value === "object" && !Array.isArray(value)
      ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value);
    const execution = { schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId: owner.companyId, runId: owner.runId, issueId: owner.issueId, agentId: owner.agentId, executionWorkspaceId: "workspace" },
      task: { identifier: "TEST", title: "Test", description: null, prompt: "Test", workMode: "standard" },
      workspace: { cwd: "/tmp/test", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: owner.nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Test", criteria: [{ id: "objective", requirement: "Test" }] } }, interactionResponses: [], credentialBindings: [] };
    const key = sha(canonical({ schema: "paperclip.native-session-scope.v2", companyId: owner.companyId, agentId: owner.agentId,
      workspace: { kind: "managed", executionWorkspaceId: "workspace" }, provider: { driverKind: "codex_app_server", identity: { kind: "codex" } }, normalizedSessionId: owner.nativeSessionId }));
    const root = join(base, key);
    const identity = { runnerInstanceId: owner.runnerInstanceId, environmentLeaseId: owner.environmentLeaseId,
      runId: owner.runId, normalizedSessionId: owner.nativeSessionId, turnId: "turn", itemId: "item" };
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceSeq: 1, priority: 1,
      emittedAt: new Date().toISOString(), turnId: "turn", itemId: "item", sourceEventId: "event-1", sourceInstanceId: owner.runnerInstanceId,
      runId: owner.runId, normalizedSessionId: owner.nativeSessionId, eventType: "session.started",
      payload: { providerSessionId: owner.providerSessionId, processId: owner.providerPid } };
    const result = { schema: "paperclip.run_result.v1", summary: "cancelled", reportedWorkDisposition: "needs_review",
      completionClaim: { contractRevision: "1", criteria: [{ criterionId: "objective", evidenceRefs: [], status: "unknown" }],
        objectiveSatisfied: false, remainingWork: [{ blocksCompletion: true, description: "Review the stopped run." }] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "needs_review" };
    const canonicalSha256 = `sha256:${nativeSha256({ result, terminal, turnId: "provider-turn" })}`;
    const accepted = { schemaStatus: "accepted", resultJson: { result, terminal }, turnId: "provider-turn", canonicalSha256,
      serverFingerprint: `sha256:${nativeSha256({ runId: owner.runId, completionContractSha256: "sha", canonicalSha256 })}` };
    const eventFor = (eventType: string, sourceSeq: number, payload: unknown) => ({ ...event, eventType, sourceSeq,
      sourceEventId: `${owner.runnerInstanceId}:${owner.runId}:${sourceSeq}`, payload });
    const identityEvent = eventFor("session.started", 1, { driverSessionId: owner.providerSessionId, providerSessionId: owner.providerSessionId, context: {} });
    const persistedIdentity = { eventType: "session.started", payload: { prpEvent: identityEvent }, sourceInstanceId: owner.runnerInstanceId,
      sourceEventId: identityEvent.sourceEventId, sourceSeq: 1, sourcePayloadSha256: nativeSha256(identityEvent) };
    const semanticEvents = [eventFor("turn.accepted", 2, { providerSessionId: owner.providerSessionId, providerTurnId: "provider-turn" }),
      eventFor("run.result.proposed", 3, result), eventFor("turn.interrupted", 4, { status: "interrupted", providerTurnId: "provider-turn" }),
      eventFor("run.terminal", 5, { ...terminal, provider: "codex" })];
    const commands = [{ type: "run.prepare", status: "completed", payload: { completionContract: { revision: "1", criterionIds: ["objective"] } } },
      { type: "turn.start", status: "completed", result: { result: { providerTurnId: "provider-turn" } } },
      ...Array.from({ length: 498 }, () => ({ type: "fixture.completed", status: "completed" }))];
    const pending = Object.fromEntries([["read1", "GET /one"], ["read2", "GET /two"], ["write", "PUT /three"]].map(([callId, operationId]) => [callId, { callId, operationId: "call_api", input: { operationId } }]));
    const receipts = { [sha("write")]: { state: "completed", operationId: "PUT /three", digest: sha(canonical({ operationId: "PUT /three" })), encryptedResult: { encrypted: "fixture" } } };
    const source = [
      ["control-plane/control-plane-state.json", { schema: "paperclip.runner.durable.control-plane-state.v1", identity, commands, committedEvents: [event, ...semanticEvents].map(payload => ({ envelope: { payload } })) }],
      ["runner/runner-state.json", { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "recoverable_failure" }],
      ["runner/codex-provider-state.json", { lifecycle: "session_open", threadId: owner.providerSessionId, config: { provider: "codex", command: "codex", cwd: "/tmp/test" }, toolBridge: { pending, turnClosed: true }, pendingEvents: [], queuedEvents: [] }],
    ] as const;
    mkdirSync(join(root, "runner"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "control-plane"), { mode: 0o700 });
    mkdirSync(join(root, "codex-home/sessions"), { recursive: true, mode: 0o700 });
    for (const [file, value] of source) writeFileSync(join(root, file), JSON.stringify(value), { mode: 0o600 });
    const originals = source.map(([file]) => readFileSync(join(root, file)));
    const fingerprint = sha(JSON.stringify(originals.map(bytes => sha(bytes.toString()))));
    Object.assign(fixture.owner, { stateDirectory: root, sourceFingerprint: fingerprint, sourceDigests: originals.map(bytes => sha(bytes.toString())) });
    const rollout = join(root, `codex-home/sessions/rollout-${owner.providerSessionId}.jsonl`);
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: owner.providerSessionId, history_mode: "legacy" } }) + "\n", { mode: 0o600 });
    const sqlite = new DatabaseSync(join(root, "codex-home/state_5.sqlite"));
    sqlite.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, history_mode TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(owner.providerSessionId, rollout, "legacy"); sqlite.close();
    const run = { id: owner.runId, companyId: owner.companyId, agentId: owner.agentId, nativeIssueId: owner.issueId, nativeSessionId: owner.nativeSessionId,
      runnerInstanceId: owner.runnerInstanceId, status: "cancelled", errorCode: "native_session_interrupted", runtimeMode: "native", processPid: null,
      processGroupId: null, processStartedAt: null, finishedAt: new Date(), completionContractId: "contract", completionContractSha256: "sha",
      resultJson: { apiToolReceipts: receipts }, runnerProfileJson: { nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local") } };
    const coordinator: Record<string, any> = { phase: "committed", resultId: "result", assessmentId: "assessment", decisionId: "decision", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, recoveryHistory: [] };
    let rolledBack = false;
    let activationMatches = false;
    const db: any = { select: () => ({ from: (table: unknown) => { const rows = table === heartbeatRuns ? [run] : table === nativeRunFinalizations ? [coordinator] : table === nativeRunResults ? [accepted] : table === heartbeatRunEvents ? [persistedIdentity] : [];
      const query: any = { where: () => query, for: () => query, orderBy: () => query, limit: async () => rows }; return query; } }),
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => { Object.assign(coordinator, values); return Object.assign(Promise.resolve([]), { returning: async () => {
        if (failBeforeRename && (values.recoveryHistory as Array<Record<string, unknown>> | undefined)?.at(-1)?.phase === "activation_prepared") throw new Error("injected before rename");
        return [{ runId: run.id }]; } }); } }) }),
      transaction: async (fn: (tx: any) => Promise<unknown>) => { const before = structuredClone(coordinator); try { const result = await fn(db);
        if (coordinator.recoveryHistory.at(-1)?.phase === "settled") {
          const marker = JSON.parse(readFileSync(join(root, "cleanup-activation.json"), "utf8"));
          const runner = JSON.parse(readFileSync(join(root, "runner/runner-state.json"), "utf8"));
          const provider = JSON.parse(readFileSync(join(root, "runner/codex-provider-state.json"), "utf8"));
          activationMatches = createCancelledCleanupAuthorityForTest(fixture.owner as never).exactCancelledClosedActivationMatches(marker, coordinator.recoveryHistory.at(-1), runner, provider);
        }
        if (failCommit && !rolledBack && coordinator.recoveryHistory.at(-1)?.phase === "settled") { rolledBack = true; throw new Error("injected commit failure"); }
        return result; } catch (error) { Object.assign(coordinator, before); throw error; } } };
    fixture.decrypt.mockReset().mockResolvedValue(JSON.stringify(mode === "unknown_receipt"
      ? { outcome: "unknown" } : { ok: true, operationId: "PUT /three" }));
    fixture.complete.mockReset();
    fixture.audit.mockReset().mockResolvedValue(undefined);
    fixture.settle.mockReset().mockImplementation(async (input) => {
      await input.authorize();
      const runnerFile = join(input.stateDirectory, "runner/runner-state.json");
      const runner = JSON.parse(readFileSync(runnerFile, "utf8")); runner.lifecycle = "suspended";
      writeFileSync(runnerFile, JSON.stringify(runner), { mode: 0o600 });
      const providerFile = join(input.stateDirectory, "runner/codex-provider-state.json");
      const provider = JSON.parse(readFileSync(providerFile, "utf8")); provider.lifecycle = "closed";
      provider.toolBridge.turnClosed = true; provider.toolBridge.pending = {};
      writeFileSync(providerFile, JSON.stringify(provider), { mode: 0o600 });
      const settledFingerprint = sha(JSON.stringify(source.map(([file]) => sha(readFileSync(join(input.stateDirectory, file)).toString()))));
      return { ...input, stagedSourceFingerprint: input.sourceFingerprint,
        reconciledToolCallsDigest: cancelledBridgeSettlementDigest(input.semanticToolResults), settledFingerprint };
    });
    if (mode.startsWith("resume")) fixture.settle.mockImplementationOnce(async (input) => {
      await input.authorize();
      const epoch = { schema: "paperclip.native_cleanup_runner_epoch.v1", requestId: input.requestId, epoch: 0,
        launchId: "fixture-launch", stateDirectory: input.stateDirectory, initialFingerprint: input.sourceFingerprint,
        runnerArtifact: { path: "/fixture/runnerd", version: "fixture", digest: "fixture" } };
      await input.recordEpoch({ ...epoch, phase: "launch_intent" });
      const spawn = { pid: 99999990, processGroupId: 99999990, processStartedAt: "fixture-start", spawnedAt: "fixture-spawn" };
      await input.recordEpoch({ ...epoch, ...spawn, phase: "spawned" });
      const first = input.semanticToolResults[0];
      const providerFile = join(input.stateDirectory, "runner/codex-provider-state.json");
      const provider = JSON.parse(readFileSync(providerFile, "utf8"));
      const call = provider.toolBridge.pending[first.callId];
      delete provider.toolBridge.pending[first.callId];
      provider.lifecycle = "closed";
      provider.toolBridge.turnClosed = true;
      provider.toolBridge.settledResults = { [first.callId]: { call, result: { callId: first.callId, operationId: first.operationId,
        result: first.result, isError: first.isError } } };
      writeFileSync(providerFile, JSON.stringify(provider), { mode: 0o600 });
      const controlFile = join(input.stateDirectory, "control-plane/control-plane-state.json");
      const control = JSON.parse(readFileSync(controlFile, "utf8"));
      control.commands = input.semanticToolResults.map((result: any, index: number) => {
        const commandId = `command_reconcile_${sha(`${input.requestId}\0${result.callId}`)}`;
        const controllerSeq = index + 1;
        return { type: "semantic_tool.result", status: index === 0 ? "completed" : "pending", commandId, controllerSeq,
          payload: { callId: result.callId, operationId: result.operationId, result: result.result, isError: result.isError },
          result: index === 0 ? { commandId, commandType: "semantic_tool.result", controllerSeq, status: "completed",
            result: { status: "settled_after_turn", callId: result.callId } } : null };
      });
      writeFileSync(controlFile, JSON.stringify(control), { mode: 0o600 });
      const runnerFile = join(input.stateDirectory, "runner/runner-state.json");
      const runner = JSON.parse(readFileSync(runnerFile, "utf8"));
      runner.processedCommands = { [control.commands[0].commandId]: control.commands[0].result };
      writeFileSync(runnerFile, JSON.stringify(runner), { mode: 0o600 });
      const finalFingerprint = sha(JSON.stringify(source.map(([file]) => sha(readFileSync(join(input.stateDirectory, file)).toString()))));
      await input.recordEpoch({ ...epoch, ...spawn, phase: "retired", processGroupAbsent: true,
        retiredAt: "fixture-retired", finalFingerprint });
      throw new Error("injected interruption after partial settlement");
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
    try {
      expect(validatePrpEvent(event)).toMatchObject({ ok: true });
      let outcome: { status: string };
      if (mode === "board_route") {
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { req.actor = { type: "board", source: "board_key", isInstanceAdmin: true,
          userId: request.actorId, companyIds: [owner.companyId] }; next(); });
        app.use("/api", cancelledNativeCleanupRoutes(db)); app.use(errorHandler);
        const response = await requestHttp(app).post(`/api/companies/${owner.companyId}/native-cleanup/cancelled`)
          .send({ runId: owner.runId, expectedFingerprint: fingerprint, requestId: request.requestId }).expect(200);
        outcome = response.body;
        expect(fixture.audit.mock.calls.map(call => call[1].action)).toEqual(["native_cleanup.cancelled_requested", "native_cleanup.cancelled_result"]);
        expect(fixture.audit.mock.calls[1]![1].details.status).toBe("settled");
      } else outcome = await reconcile(db, { ...request, expectedFingerprint: fingerprint });
      if (mode.startsWith("resume")) {
        expect(outcome.status).toBe("operator_required");
        expect(fixture.settle).toHaveBeenCalledTimes(1);
        if (mode === "resume") {
          const first = fixture.settle.mock.calls[0]![0];
          const loadSnapshot = (directory: string) => { const bytes = source.map(([file]) => readFileSync(join(directory, file)));
            return { fingerprint: sha(JSON.stringify(bytes.map(value => sha(value.toString())))), control: JSON.parse(bytes[0]!.toString()),
              runner: JSON.parse(bytes[1]!.toString()), provider: JSON.parse(bytes[2]!.toString()) }; };
          const archive = coordinator.recoveryHistory.find((e: any) => e.kind === "native_cleanup_source_archive" && e.phase === "archived");
          expect(readCancelledRecoveryEpoch({ intentRoot: join(container, "board-cancelled-recovery"), boardRequestId: request.requestId,
            history: coordinator.recoveryHistory, original: loadSnapshot(join(base, "quarantine", archive.archiveName)),
            staged: loadSnapshot(first.stateDirectory), stagedDirectory: first.stateDirectory, fullPlan: first.semanticToolResults })).not.toBeNull();
        }
        if (mode === "resume_bad_epoch") coordinator.recoveryHistory.find((e: any) => e.kind === "native_cleanup_runner_epoch" && e.phase === "retired").finalFingerprint = "0".repeat(64);
        if (mode === "resume_bad_receipt") receipts[sha("write")].digest = "0".repeat(64);
        if (mode === "resume_bad_runner_receipt") {
          const staged = fixture.settle.mock.calls[0]![0].stateDirectory;
          const runnerPath = join(staged, "runner/runner-state.json");
          const runner = JSON.parse(readFileSync(runnerPath, "utf8"));
          runner.processedCommands = {};
          writeFileSync(runnerPath, JSON.stringify(runner), { mode: 0o600 });
          coordinator.recoveryHistory.find((e: any) => e.kind === "native_cleanup_runner_epoch" && e.phase === "retired").finalFingerprint =
            sha(JSON.stringify(source.map(([file]) => sha(readFileSync(join(staged, file)).toString()))));
        }
        const retry = mode === "resume_bad_request" ? { ...request, requestId: "b1e52d6f-4d43-4db8-a7af-99f010001111" } : request;
        outcome = await reconcile(db, { ...retry, expectedFingerprint: fingerprint });
        if (mode !== "resume") {
          expect(outcome.status).toBe("not_eligible");
          expect(fixture.settle).toHaveBeenCalledTimes(1);
          expect(fixture.complete).not.toHaveBeenCalled();
          expect(existsSync(join(container, "board-cancelled-recovery", `${owner.runId}.json.started`))).toBe(true);
          expect(existsSync(join(container, "board-cancelled-recovery", `${owner.runId}.json.used`))).toBe(false);
          const archive = coordinator.recoveryHistory.find((e: any) => e.kind === "native_cleanup_source_archive" && e.phase === "archived");
          expect(source.map(([file]) => readFileSync(join(base, "quarantine", archive.archiveName, file)))).toEqual(originals);
          expect(existsSync(root)).toBe(false);
          return;
        }
        expect(fixture.settle).toHaveBeenCalledTimes(2);
        const resumed = fixture.settle.mock.calls[1]![0];
        expect(resumed.priorRetiredEpoch.phase).toBe("retired");
        expect(resumed.semanticToolResults).toHaveLength(2);
      }
      expect(fixture.decrypt).toHaveBeenCalledTimes(mode === "resume" ? 2 : 1);
      if (mode === "unknown_receipt") {
        expect(outcome.status).toBe("not_eligible");
        expect(fixture.settle).not.toHaveBeenCalled();
        expect(source.map(([file]) => readFileSync(join(root, file)))).toEqual(originals);
        return;
      }
      expect(fixture.settle).toHaveBeenCalledTimes(mode === "resume" ? 2 : 1);
      expect(outcome.status).toBe(failCommit || failBeforeRename ? "operator_required" : "settled");
      if (!failBeforeRename) expect(activationMatches).toBe(true);
      expect(fixture.complete).toHaveBeenCalledTimes(failCommit || failBeforeRename ? 0 : 1);
      expect(existsSync(join(container, "board-cancelled-recovery", `${owner.runId}.json.used`))).toBe(!failBeforeRename);
      expect(existsSync(join(container, "board-cancelled-recovery", `${owner.runId}.json.started`))).toBe(failBeforeRename);
      expect(coordinator.recoveryHistory.some((entry: any) => entry.kind === "native_cleanup_maintenance" && entry.phase === "settled")).toBe(!failCommit && !failBeforeRename);
      const archived = coordinator.recoveryHistory.find((entry: any) => entry.kind === "native_cleanup_source_archive" && entry.phase === "archived");
      expect(archived).toBeDefined();
      expect(source.map(([file]) => readFileSync(join(base, "quarantine", archived.archiveName, file)))).toEqual(originals);
      if (failCommit) expect(readFileSync(join(root, "cleanup-activation.json"), "utf8")).toContain(fingerprint);
      if (failBeforeRename) {
        expect(existsSync(root)).toBe(false);
        const staged = readdirSync(base).find(name => name.startsWith(`${key}.cleanup-`));
        expect(staged).toBeDefined();
        expect(readFileSync(join(base, staged!, "cleanup-activation.json"), "utf8")).toContain(fingerprint);
      }
    } finally { kill.mockRestore(); fixture.enabled = false; Object.assign(fixture.owner, oldOwner);
      if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = previous;
      rmSync(container, { recursive: true, force: true }); }
  });
});
