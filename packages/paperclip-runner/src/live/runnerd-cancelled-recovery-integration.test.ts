import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane, durableRecoveryInternals } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary, retainedRunnerdCleanupProofIsCurrent,
  settleRetainedRunnerdSession } from "./runnerd-codex-transport.js";
import { completeRetainedNativeSessionCleanup } from "../native-session-runtime.js";
import { cancelledBridgeSettlementDigest, createCancelledCleanupAuthorityForTest } from "../../../../server/src/services/native-runtime/cancelled-retained-cleanup-authority.js";
import { createCancelledRecoveryEpochReaderForTest } from "../../../../server/src/services/native-runtime/cancelled-recovery-epoch.js";
import { nativeSha256 } from "../../../../server/src/services/native-runtime/canonical.js";


const files = ["control-plane/control-plane-state.json", "runner/runner-state.json", "runner/codex-provider-state.json"];
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
function snapshot(dir: string) {
  const bytes = files.map(file => readFileSync(join(dir, file)));
  return { control: JSON.parse(bytes[0]!.toString()), runner: JSON.parse(bytes[1]!.toString()),
    provider: JSON.parse(bytes[2]!.toString()), fingerprint: hash(JSON.stringify(bytes.map(hash))), digests: bytes.map(hash) };
}

it.each(["closed", "session_open"])("joins real retired Runner partial settlement from %s to the exact one-shot Board intent", async (initialLifecycle) => {
  const scratch = "/Volumes/NVM/AI_Agent_Runtime/tmp";
  const dir = await mkdtemp(join(existsSync(scratch) ? scratch : tmpdir(), "runner-cancelled-integration-"));
  const original = join(dir, "original"), activation = join(dir, "activation"), stage = join(dir, "activation.cleanup-fixture"), home = join(dir, "home");
  await mkdir(home);
  const runnerBinary = process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary();
  const fakeCodex = resolve(import.meta.dirname, "../../runner/target/debug/fake-codex-app-server");
  const fakeState = join(dir, "fake.json"), callsLog = join(dir, "calls.log");
  const identity = { runnerInstanceId: "runner-fixture", environmentLeaseId: "lease-fixture", runId: "run-fixture",
    normalizedSessionId: "session-fixture", turnId: "turn-fixture", itemId: "item-fixture" };
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary, codexCommand: fakeCodex,
    codexArgs: ["--state-file", fakeState, "--call-log", callsLog, "--hold-turn"], sourceCodexHome: home,
    stateDirectory: original, prpIdentity: identity });
  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
  let runnerPid = 0, providerPid = 0;
  try {
    const thread = await bundle.transport.request("thread/start", { cwd: dir, dynamicTools: [] }) as { thread: { id: string } };
    await bundle.transport.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "fixture" }] });
    runnerPid = bundle.evidence().runnerPid!; providerPid = bundle.evidence().providerPid!;
    await bundle.detachControllerForRestart();
    for (const pid of [runnerPid, providerPid]) try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await vi.waitFor(() => { expect(dead(runnerPid)).toBe(true); expect(dead(providerPid)).toBe(true); });
    const fake = JSON.parse(await readFile(fakeState, "utf8"));
    await writeFile(fakeState, JSON.stringify({ ...fake, activeTurnId: null }));
    new DurablePrpControlPlane({ stateDirectory: join(original, "control-plane"), identity, expectedRunnerVersion: "0.3.0",
      expectedRunnerDigest: `sha256:${hash(await readFile(runnerBinary))}` });
    const providerFile = join(original, "runner/codex-provider-state.json");
    const provider = JSON.parse(await readFile(providerFile, "utf8"));
    const digest = (value: unknown) => hash(durableRecoveryInternals.canonicalJson(value));
    const pending = [ { callId: "read", operationId: "paperclip_api", input: { operationId: "GET /fixture" } },
      { callId: "write", operationId: "paperclip_api", input: { operationId: "POST /fixture" } } ];
    const plan = pending.map((call, i) => ({ callId: call.callId, operationId: call.operationId, inputDigest: digest(call.input),
      disposition: i ? "completed_api_receipt" as const : "read_cancelled" as const,
      result: i ? { id: "fixture-receipt" } : { error: "cancelled" }, isError: !i }));
    const tool = { operationId: "paperclip_api", version: 1, description: "API", inputSchema: { type: "object" }, responseSchema: { type: "object" } };
    provider.lifecycle = initialLifecycle; provider.activeProviderTurnId = null;
    provider.toolBridge = { ...provider.toolBridge, authorized: { paperclip_api: tool }, catalogOperations: [tool], catalogDigest: `sha256:${digest([tool])}`,
      pending: Object.fromEntries(pending.map(call => [call.callId, call])), turnClosed: true };
    await writeFile(providerFile, JSON.stringify(provider));
    const source = snapshot(original); await cp(original, stage, { recursive: true });
    const requestLease = `native-cleanup:${randomUUID()}`, boardRequestId = randomUUID();
    const owner = { companyId: "company-fixture", issueId: "issue-fixture", agentId: "agent-fixture", runId: identity.runId,
      nativeSessionId: identity.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId, environmentLeaseId: identity.environmentLeaseId,
      providerSessionId: thread.thread.id, runnerPid, providerPid, stateDirectory: activation,
      sourceFingerprint: source.fingerprint, sourceDigests: source.digests };
    const intentRoot = join(dir, "intents"); await mkdir(intentRoot, { mode: 0o700 });
    await writeFile(join(intentRoot, `${owner.runId}.json.started`), JSON.stringify({ schema: "paperclip.cancelled_recovery_intent.v1",
      status: "prepared", requestId: boardRequestId, runId: owner.runId, nativeSessionId: owner.nativeSessionId,
      runnerInstanceId: owner.runnerInstanceId, originalFingerprint: owner.sourceFingerprint }), { mode: 0o600 });
    const history: Record<string, unknown>[] = [
      { kind: "native_cleanup_board_authorization", version: 1, requestId: boardRequestId, requestLease,
        sourceFingerprint: source.fingerprint, reconciledToolCallsDigest: cancelledBridgeSettlementDigest(plan) },
      { kind: "native_cleanup_maintenance", version: 1, phase: "started", requestId: requestLease, sourceFingerprint: source.fingerprint },
      { kind: "native_cleanup_maintenance", version: 1, phase: "staged", requestId: requestLease, sourceFingerprint: source.fingerprint, stagingName: basename(stage) },
    ];
    const abort = new AbortController();
    const input = { requestId: requestLease, binding: { companyId: owner.companyId, issueId: owner.issueId, agentId: owner.agentId,
      runId: owner.runId, sessionId: owner.nativeSessionId }, backend: { kind: "runner" as const, name: "codex_app_server" },
      identity, stateDirectory: stage, activationDirectory: activation, sourceFingerprint: source.fingerprint, providerSessionId: owner.providerSessionId,
      originalRunnerPid: runnerPid, originalProviderPid: providerPid, runnerBinary, sourceCodexHome: home,
      authorize: async () => {}, appendEvent: async () => {}, signal: abort.signal,
      recordEpoch: async (receipt: Record<string, unknown>) => { history.push({ kind: "native_cleanup_runner_epoch", version: 1, ...receipt }); },
      semanticToolResults: plan };
    const attach = DurablePrpControlPlane.prototype.attachWireConnection;
    let interrupted = false;
    const spy = vi.spyOn(DurablePrpControlPlane.prototype, "attachWireConnection").mockImplementation(function (wire) {
      return attach.call(this, { sendJson(value) {
        if (!interrupted) {
          const s = snapshot(stage), commands = s.control.commands.filter((c: any) => c.type === "semantic_tool.result");
          if (commands.length === 2 && commands[0].status === "completed" && commands[1].status === "pending" &&
              Object.keys(s.provider.toolBridge.pending).join(",") === "write") interrupted = true;
        }
        if (interrupted) { abort.abort(new Error("fixture interruption")); return; }
        wire.sendJson(value);
      }, close: code => wire.close(code), onJson: listener => wire.onJson(listener), onClose: listener => wire.onClose(listener) });
    });
    try { await expect(settleRetainedRunnerdSession(input)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(interrupted).toBe(true);
    const partial = snapshot(stage);
    const semantic = partial.control.commands.filter((c: any) => c.type === "semantic_tool.result");
    expect(semantic.map((c: any) => c.status)).toEqual(["completed", "pending"]);
    expect(history.filter(e => e.kind === "native_cleanup_runner_epoch").map(e => e.phase)).toEqual(["launch_intent", "spawned", "retired"]);
    expect(partial.runner.processedCommands[semantic[0].commandId]).toEqual(semantic[0].result);
    expect(semantic[0].result.result).toMatchObject({ callId: "read", status: "settled_after_turn" });
    expect(history.filter(e => e.kind === "native_cleanup_runner_epoch").at(-1)?.finalFingerprint).toBe(partial.fingerprint);
    expect(partial.provider.lifecycle).toBe("closed");
    expect(source.control.identity).toMatchObject(identity);
    expect(partial.control.identity).toMatchObject(identity);
    expect(partial.runner).toMatchObject(identity);
    expect(partial.control.commands.filter((c: any) => c.status === "pending").map((c: any) => c.type)).toEqual(["semantic_tool.result", "runner.drain"]);
    expect(semantic.map((c: any) => c.commandId)).toEqual(plan.map(p => `command_reconcile_${hash(`${requestLease}\0${p.callId}`)}`));
    expect(partial.provider.toolBridge.settledResults.read).toMatchObject({ call: pending[0], result: {
      callId: plan[0]!.callId, operationId: plan[0]!.operationId, result: plan[0]!.result, isError: plan[0]!.isError } });
    expect(partial.provider.toolBridge.pending.write).toEqual(pending[1]);
    expect(plan.map(p => p.inputDigest)).toEqual(pending.map(p => nativeSha256(p.input)));
    expect(partial.provider.toolBridge.turnClosed).toBe(true);
    expect(partial.provider.threadId).toBe(owner.providerSessionId);
    expect(history.filter(e => e.kind === "native_cleanup_runner_epoch").every(e => e.requestId === requestLease && e.stateDirectory === stage)).toBe(true);
    expect(source.runner).toMatchObject(identity);
    expect(semantic[0].result).toMatchObject({ commandId: semantic[0].commandId, commandType: semantic[0].type,
      controllerSeq: semantic[0].controllerSeq, status: "completed" });
    expect(semantic.map((c: any) => c.payload)).toEqual(plan.map(p => ({ callId: p.callId, operationId: p.operationId, result: p.result, isError: p.isError })));
    const epochs = history.filter(e => e.kind === "native_cleanup_runner_epoch");
    expect(epochs.map(e => e.epoch)).toEqual([0, 0, 0]);
    expect(epochs.map(e => e.version)).toEqual([1, 1, 1]);
    expect(epochs.map(e => e.schema)).toEqual(Array(3).fill("paperclip.native_cleanup_runner_epoch.v1"));
    expect(epochs.map(e => e.initialFingerprint)).toEqual(Array(3).fill(epochs[0]!.initialFingerprint));
    expect(Number.isSafeInteger(semantic[0].controllerSeq)).toBe(true);
    expect(epochs[2]).toMatchObject({ processGroupAbsent: true, pid: epochs[1]!.pid,
      processGroupId: epochs[1]!.processGroupId, processStartedAt: epochs[1]!.processStartedAt, spawnedAt: epochs[1]!.spawnedAt });
    expect(typeof epochs[2]!.processStartedAt).toBe("string");
    expect(epochs[2]!.processGroupId).toBe(epochs[2]!.pid);
    expect(epochs.map(e => e.runnerArtifact)).toEqual(Array(3).fill(epochs[0]!.runnerArtifact));
    expect(epochs.map(e => e.launchId)).toEqual(Array(3).fill(epochs[0]!.launchId));
    const lineage = createCancelledRecoveryEpochReaderForTest(owner)({ intentRoot, boardRequestId, history, original: source,
      staged: partial, stagedDirectory: stage, fullPlan: plan });
    expect(lineage).not.toBeNull();
    const retry = { ...input, requestId: `native-cleanup:${randomUUID()}`, sourceFingerprint: partial.fingerprint,
      signal: undefined, priorRetiredEpoch: lineage!.priorRetiredEpoch as never, semanticToolResults: lineage!.semanticToolResults };
    await expect(settleRetainedRunnerdSession({ ...retry, semanticToolResults: [{ ...retry.semanticToolResults[0]!, result: { id: "changed" } }] })).rejects.toThrow();
    await expect(settleRetainedRunnerdSession({ ...retry, providerSessionId: "foreign-session" })).rejects.toThrow();
    await expect(settleRetainedRunnerdSession({ ...retry, originalProviderPid: providerPid + 100000 })).rejects.toThrow();
    if (initialLifecycle === "session_open") {
      const retired = lineage!.priorRetiredEpoch as any;
      expect(retired.retainedProviderIdentities).toHaveLength(1);
      const known = retired.retainedProviderIdentities[0];
      for (const altered of [{ ...known, processId: known.processId + 1 }, { ...known, eventDigest: "foreign" },
        { ...known, payloadDigest: "foreign" }, { ...known, eventType: "harness.ready" }]) {
        await expect(settleRetainedRunnerdSession({ ...retry, priorRetiredEpoch: { ...retired, retainedProviderIdentities: [altered] } })).rejects.toThrow();
      }
      const runnerPath = join(stage, "runner/runner-state.json"), providerPath = join(stage, "runner/codex-provider-state.json");
      const runnerBytes = await readFile(runnerPath), providerBytes = await readFile(providerPath);
      try {
        const foreignRunner = JSON.parse(runnerBytes.toString()), foreignProvider = JSON.parse(providerBytes.toString());
        const index = foreignProvider.pendingEvents.findIndex((event: any) => event.eventType === "session.resumed");
        const [foreignEvent] = foreignProvider.pendingEvents.splice(index, 1);
        expect(foreignEvent.eventType).toBe("session.resumed");
        foreignRunner.outbox.push({ envelope: { payload: foreignEvent } });
        await writeFile(runnerPath, JSON.stringify(foreignRunner)); await writeFile(providerPath, JSON.stringify(foreignProvider));
        const foreignFingerprint = snapshot(stage).fingerprint;
        await expect(settleRetainedRunnerdSession({ ...retry, sourceFingerprint: foreignFingerprint,
          priorRetiredEpoch: { ...retired, finalFingerprint: foreignFingerprint } })).rejects.toThrow();
      } finally { await writeFile(runnerPath, runnerBytes); await writeFile(providerPath, providerBytes); }
    }
    const callsBeforeRetry = (await readFile(callsLog, "utf8")).trim().split("\n");
    const proof = await settleRetainedRunnerdSession(retry);
    await rename(stage, activation);
    expect(retainedRunnerdCleanupProofIsCurrent(proof)).toBe(true);
    const authority = createCancelledCleanupAuthorityForTest(owner);
    expect(authority.consumePreparedCancelledIntent({ root: intentRoot, runId: owner.runId, requestId: boardRequestId,
      originalFingerprint: source.fingerprint, expectedReconciledToolCallsDigest: cancelledBridgeSettlementDigest(plan),
      settledProof: proof, resumeLineage: lineage! })).toBe(true);
    expect(authority.consumePreparedCancelledIntent({ root: intentRoot, runId: owner.runId, requestId: boardRequestId,
      originalFingerprint: source.fingerprint, expectedReconciledToolCallsDigest: cancelledBridgeSettlementDigest(plan),
      settledProof: proof, resumeLineage: lineage! })).toBe(false);
    completeRetainedNativeSessionCleanup(proof);
    expect(snapshot(original).fingerprint).toBe(source.fingerprint);
    expect(snapshot(activation).provider.toolBridge.pending).toEqual({});
    const methods = (await readFile(callsLog, "utf8")).trim().split("\n");
    expect(methods.filter(x => x === "turn/start")).toHaveLength(1);
    expect(methods.filter(x => x === "thread/resume")).toHaveLength(callsBeforeRetry.filter(x => x === "thread/resume").length);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    for (const pid of [runnerPid, providerPid]) if (pid > 0 && !dead(pid)) try { process.kill(-pid, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);
