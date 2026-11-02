import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { agentTaskSessions, agents, companies, companySecretVersions, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { verifyOpenCodeBridgeReceiptLink, verifyOpenCodeBridgeReceiptSet } from "./opencode-bridge-receipt-link.js";

describeEmbeddedPostgres("OpenCode successor process restoration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("opencode-successor-process-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  it.runIf(process.platform === "darwin").each([false, true])("qualifies successor restoration or returned-history hold (history=%s)", async (returnedHistory) => {
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-successor-owned-");
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID(), providerSessionId = `ses_${randomUUID()}`, epoch = randomUUID();
    let requests = 0, host: any, original: ChildProcess | undefined, successor: ChildProcess | undefined, foreign: ReturnType<typeof createServer> | undefined;
    const upstream = createServer((req, res) => { requests++; if (req.method === "GET" && req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); } else res.writeHead(500).end(); });
    await new Promise<void>(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
    const providerBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    const child = () => spawn(process.execPath, ["--import", resolve(import.meta.dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(import.meta.dirname, "opencode-successor-process.fixture.ts")], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, PAPERCLIP_SECRETS_MASTER_KEY: "91".repeat(32) } });
    const next = (p: ChildProcess) => new Promise<any>((resolveMessage, reject) => { const timer = setTimeout(() => reject(new Error("fixture_timeout")), 30_000); p.once("error", reject); p.once("message", message => { clearTimeout(timer); resolveMessage(message); }); p.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture_exit_${code}`)); }); });
    try {
      await db.insert(companies).values({ id: companyId, name: "Successor", issuePrefix: returnedHistory ? "OCR" : "OCS" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { dotWorkspaceAccess: true } });
      await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue", assigneeAgentId: agentId, status: "in_progress" });
      const execution = buildNativeExecutionInput({ companyId, runId, agentId, issue: { id: issueId, identifier: "OCS-1", title: "Issue", description: null, workMode: "standard" }, taskPrompt: "Issue", workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId, provider: "opencode_shared_v2", model: "paperclip/fixture-model", opencodeEffort: "high", completionContract: { id: "fixture", sha256: "sha256:" + "a".repeat(64), schemaVersion: "v1", contract: { revision: "fixture", objective: "Issue", criteria: [{ id: "c", requirement: "Done" }] } }, runtimeContext: nativeRuntimeContextFixture() });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: {} });
      original = child(); const readyPromise = next(original);
      original.send!({ mode: "original", connectionString: temporary.connectionString, root, providerBase, epoch, providerSessionId, leaseOwner: "original", returnedHistory });
      const ready = await readyPromise; expect(ready.stage, ready.error).toBe("ready");
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", leaseOwner: "original", attempt: 1, leaseExpiresAt: new Date(Date.now() + 300_000), controllerBootId: ready.controller.bootId, controllerPid: ready.controller.pid, controllerProcessStartedAt: new Date(ready.controller.processStartedAt), controllerGeneration: 1 });
      const createdPromise = next(original);
      original.send!({ companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId, model: "paperclip/fixture-model", effort: "high" });
      const created = await createdPromise; expect(created.stage, created.error).toBe("created");
      if (returnedHistory) expect(created.returnedActiveEmpty).toBe(true);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
      const native = (saved!.sessionParamsJson as any).opencodeSharedV2; host = native.host;
      expect(host.secretId).toBeTruthy(); expect(JSON.stringify(saved!.sessionParamsJson)).not.toContain("fixture-key");
      const encrypted = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, host.secretId));
      expect(encrypted).toHaveLength(1); expect(JSON.stringify(encrypted[0]!.material)).not.toContain("fixture-key");
      const originalExit = new Promise<void>((resolveExit, reject) => original!.once("exit", code => code === 0 ? resolveExit() : reject(new Error("original_exit_failed"))));
      original.send!("lose-controller"); await originalExit;
      expect(await readProcessStartedAt(host.pid)).toBe(host.startedAt);
      if (returnedHistory) {
        expect(native.semanticCalls).toMatchObject([{ tool: "workspace_write", state: "returned", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/), authorityReceipt: { schema: "opencode.bridge-receipt-link.v1", runId, sessionId: providerSessionId, epoch } }]);
        const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "opencode.shared.semantic")));
        expect(events).toHaveLength(2);
        expect(events.map(event => event.payload)).toContainEqual(expect.objectContaining({ sessionId: providerSessionId, epoch, operationId: native.semanticCalls[0].operationId, digest: native.semanticCalls[0].digest, resultDigest: native.semanticCalls[0].resultDigest, state: "returned" }));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const identity = { runId, providerSessionId, epoch }, entry = native.semanticCalls[0];
        expect(verifyOpenCodeBridgeReceiptLink(identity, entry, run!.resultJson)).toBe(true);
        expect(verifyOpenCodeBridgeReceiptSet(identity, [entry, entry], run!.resultJson, entry.operationId)).toBe(false);
        for (const changed of [ { ...identity, runId: randomUUID() }, { ...identity, epoch: randomUUID() }, { ...identity, providerSessionId: "ses_foreign" } ]) expect(verifyOpenCodeBridgeReceiptLink(changed, entry, run!.resultJson)).toBe(false);
        for (const changed of [ { ...entry, digest: "0".repeat(64) }, { ...entry, resultDigest: "0".repeat(64) }, { ...entry, state: "reserved" }, { ...entry, authorityReceipt: { ...entry.authorityReceipt, key: "0".repeat(64) } }, { ...entry, authorityReceipt: undefined } ]) expect(verifyOpenCodeBridgeReceiptLink(identity, changed, run!.resultJson)).toBe(false);
        expect(verifyOpenCodeBridgeReceiptLink(identity, entry, {})).toBe(false);
        const changedResult = structuredClone(run!.resultJson as any); changedResult.bridgeToolReceipts[entry.authorityReceipt.key].result = { changed: true };
        expect(verifyOpenCodeBridgeReceiptLink(identity, entry, changedResult)).toBe(false);
        const pendingResult = structuredClone(run!.resultJson as any); pendingResult.bridgeToolReceipts[entry.authorityReceipt.key].state = "pending";
        expect(verifyOpenCodeBridgeReceiptLink(identity, entry, pendingResult)).toBe(false);
        expect(await claimNativeRestartRecoveries({ db, runIds: [runId], restartKind: "hard" })).toMatchObject([{ kind: "awaiting_evidence", reason: "opencode_restart_outcome_unknown" }]);
        expect(requests).toBe(0);
        return;
      }
      for (const unsafe of [{ mutations: [{ state: "reserved" }] }, { semanticCalls: [{ state: "reserved" }] }, { mcpRestoration: { state: "reserved" } }]) {
        await db.update(agentTaskSessions).set({ sessionParamsJson: { opencodeSharedV2: { ...native, ...unsafe } } }).where(eq(agentTaskSessions.id, taskSessionId));
        expect(await claimNativeRestartRecoveries({ db, runIds: [runId], restartKind: "hard" })).toMatchObject([{ kind: "awaiting_evidence", reason: "opencode_restart_outcome_unknown" }]);
      }
      await db.update(agentTaskSessions).set({ sessionParamsJson: { opencodeSharedV2: { ...native, host: { ...host, pid: process.pid } } } }).where(eq(agentTaskSessions.id, taskSessionId));
      expect(await claimNativeRestartRecoveries({ db, runIds: [runId], restartKind: "hard" })).toMatchObject([{ kind: "awaiting_evidence", reason: "opencode_saved_host_unqualified" }]);
      await db.update(agentTaskSessions).set({ sessionParamsJson: { opencodeSharedV2: native } }).where(eq(agentTaskSessions.id, taskSessionId));
      const foreignListener = createServer(); foreign = foreignListener;
      await new Promise<void>((resolveListen, reject) => { foreignListener.once("error", reject); foreignListener.listen(ready.proxyPort, "127.0.0.1", resolveListen); });
      successor = child(); const restoredPromise = next(successor);
      successor.send!({ mode: "successor", connectionString: temporary.connectionString, providerBase, runId, runnerInstanceId, execution });
      const held = await restoredPromise; expect(held.stage, held.error).toBe("port-held");
      await new Promise<void>(resolveClose => foreignListener.close(() => resolveClose()));
      const continued = next(successor); successor.send!("port-released");
      const restored = await continued; expect(restored.stage, restored.error).toBe("restored");
      expect(restored.controller.pid).not.toBe(ready.controller.pid);
      expect(restored).toMatchObject({ hostPid: host.pid, proxyPort: ready.proxyPort, sessionId: providerSessionId, generation: ready.generation, epoch, denied: 503, toolDenied: true, changedEpochDenied: true, portTakeoverDenied: true, oldLeaseDenied: true });
      expect(restored.activeShape).toEqual({ status: 200, rootArray: false, dataArray: false, rootKeys: ["data"], dataType: "object", dataKeys: [] });
      expect(requests).toBe(2); // two model discoveries only; no prompt/generation.
      const [after] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
      const history = (after!.sessionParamsJson as any).opencodeSharedV2;
      expect(history.mcpRestoration.state).toBe("completed"); expect(history.mutations ?? []).toEqual([]); expect(history.semanticCalls ?? []).toEqual([]);
      const successorExit = new Promise<void>((resolveExit, reject) => successor!.once("exit", code => code === 0 ? resolveExit() : reject(new Error("successor_exit_failed"))));
      successor.send!("close"); await successorExit;
    } finally {
      if (successor && successor.exitCode === null && successor.signalCode === null) successor.kill("SIGTERM");
      if (original && original.exitCode === null && original.signalCode === null) original.kill("SIGTERM");
      if (foreign?.listening) await new Promise<void>(resolveClose => foreign!.close(() => resolveClose()));
      let nativeStillAlive = false;
      if (host && await readProcessStartedAt(host.pid).catch(() => null) === host.startedAt) {
        process.kill(host.pid, "SIGTERM");
        let alive = true;
        for (let attempt = 0; attempt < 30 && alive; attempt++) {
          await new Promise(resolveWait => setTimeout(resolveWait, 100));
          alive = await readProcessStartedAt(host.pid).catch(() => null) === host.startedAt;
        }
        nativeStillAlive = alive;
      }
      await new Promise<void>(resolveClose => upstream.close(() => resolveClose()));
      if (nativeStillAlive) throw new Error("fixture_native_exit_unconfirmed");
    }
  }, 90_000);
});
