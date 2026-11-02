import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { agents, agentSessionGoalActions, agentTaskSessions, companies, completionContracts, createDb, environmentLeases, executionWorkspaces, goals, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { costEvents, issueComments, statusDecisions } from "@paperclipai/db";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { accountRunCost } from "../run-cost-accounting.js";
import { settleLiveRunnerGoalBeforeInterrupt } from "../runner-goals.js";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { cancelNativeSession, executePaperclipNativeSession } from "./native-session-executor.js";
import { localNativeDaemonHost, registerCodexNativeDelegation } from "./codex-native-delegation.js";
import { dispatchLiveRunnerGoalControl } from "../runner-goal-control-broker.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../../realtime/runner-prp-ws.js";

// Trace seam: records every PRP event the executor hands to the goal projection (type, seq, objective, status).
const projected: string[] = [];
vi.mock("../runner-goals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner-goals.js")>();
  return { ...actual, applyRunnerGoalPrpEvent: (...args: Parameters<typeof actual.applyRunnerGoalPrpEvent>) => {
    const event = args[2]; const goal = (event.payload as any)?.goal;
    if (event.eventType.startsWith("session.goal")) projected.push(`${event.eventType}#${event.sourceSeq}:${goal?.objective ?? "-"}/${goal?.status ?? "-"}`);
    return actual.applyRunnerGoalPrpEvent(...args);
  } };
});

/**
 * C1 canary harness (owner-admitted: one Codex turn, gpt-6-luna, model_reasoning_effort=low, no retry, no ACTIVE goal).
 *
 * Skipped unless PAPERCLIP_C1_CANARY_WORD=C1. PAPERCLIP_C1_HOST selects the daemon:
 *   isolated (default) - throwaway daemon in a temp HOME, no credentials, wiring check: stops before the turn.
 *   owner              - the already-running owner daemon (~/.codex, brew codex). Submits exactly ONE turn.
 * The owner mode never starts, restarts or stops the owner daemon and never reads ~/.codex credentials; the daemon
 * authenticates itself. The embedded Postgres, registration, grant and issue live only inside this process.
 * Stop conditions (recorded, then asserted): a second turn start, any tool call, any goal that is not paused,
 * model/effort other than gpt-6-luna/low. The turn itself is bounded by turnTimeoutMs; the executor is called once
 * (no heartbeat orchestration, so no retry or continuation exists).
 */
const MODEL = "gpt-6-luna", EFFORT = "low";
const armed = process.env.PAPERCLIP_C1_CANARY_WORD === "C1";
const ownerMode = process.env.PAPERCLIP_C1_HOST === "owner";

(armed ? it : it.skip)(`C1 canary harness (${ownerMode ? "owner daemon, one turn" : "isolated daemon, stops before the turn"})`, async () => {
  const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/codex-c1-");
  const workspace = join(root, "workspace"), assets = join(root, "assets");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "AGENTS.md"), "C1 canary instructions\n");
  const exec = promisify(execFile), cli = "/opt/homebrew/bin/codex";
  const runner = process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? "/Volumes/NVM/AI_Agent_Runtime/tmp/lead-rust-target/debug/paperclip-runnerd";
  const ownerHome = homedir();
  const home = ownerMode ? ownerHome : join(root, "home"), codexHome = ownerMode ? join(ownerHome, ".codex") : home;
  const env = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome, TMPDIR: ownerMode ? process.env.TMPDIR ?? "/Volumes/NVM/AI_Agent_Runtime/tmp" : home, LANG: "C" };
  if (ownerMode) {
    // Read-only liveness check; refuses to run when the owner daemon is not already up or is not 0.166.0.
    const { stdout } = await exec(cli, ["app-server", "daemon", "version"], { cwd: root, env, timeout: 15000 });
    expect(stdout).toContain("0.166.0");
  } else {
    await mkdir(join(home, "app-server-daemon"), { recursive: true });
    await writeFile(join(home, "app-server-daemon", "settings.json"), JSON.stringify({ remoteControlEnabled: false, updater: { autoUpdateEnabled: false } }));
    await exec(cli, ["app-server", "daemon", "start"], { cwd: root, env, timeout: 15000 });
  }
  const database = await startEmbeddedPostgresTestDatabase("codex-c1-"); const db = createDb(database.connectionString);
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("harness_listener_missing");
  setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
  const violations: string[] = [], turnStarts: string[] = [], goalEvents: string[] = [], usage: unknown[] = [], tools: string[] = [];
  try {
    const companyId = randomUUID(), projectId = randomUUID(), goalId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID(), workspaceId = randomUUID(), leaseId = randomUUID(), contractId = randomUUID(), sha = "sha256:" + "a".repeat(64);
    await db.insert(companies).values({ id: companyId, name: "C1 canary", issuePrefix: "CCA" }); await db.insert(projects).values({ id: projectId, companyId, name: "C1 canary" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Goal", level: "company" });
    await db.insert(agents).values({ id: agentId, companyId, name: "C1 canary agent", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, goalId, title: "C1 canary (disposable)", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "v1", policyVersion: "c1", risk: "low", completionAuthority: "worker", incompleteCriteriaPolicy: "block", contractJson: { revision: "c1", criteria: [{ id: "c" }] }, canonicalSha256: sha, createdByActorType: "system", createdByActorId: "c1-harness" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId, status: "running", runtimeMode: "native", completionContractId: contractId, completionContractSha256: sha });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId)); await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "pending" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, name: "C1", mode: "shared", strategyType: "local" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, executionWorkspaceId: workspaceId, status: "active" });
    const host = { hostId: ownerMode ? "owner" : "isolated", codexExecutable: cli, codexHome, runnerExecutable: runner, home };
    const delegation = await registerCodexNativeDelegation(db, localNativeDaemonHost(host), { companyId, projectId, agentId, model: MODEL, effort: EFFORT, issuer: "board", expiresAt: new Date(Date.now() + 15 * 60_000) });
    for (const [key, value] of Object.entries({ PAPERCLIP_RUNNER_BINARY: runner, PAPERCLIP_HOME: root, PAPERCLIP_CODEX_SHARED_AGENT_ID: agentId, PAPERCLIP_CODEX_SHARED_GRANT_ID: delegation.grantId, PAPERCLIP_CODEX_SHARED_HOST_ID: host.hostId, PAPERCLIP_CODEX_SHARED_EXECUTABLE: cli, PAPERCLIP_CODEX_SHARED_CODEX_HOME: codexHome, PAPERCLIP_CODEX_SHARED_HOME: home, PAPERCLIP_SECRETS_MASTER_KEY: "91".repeat(32) })) vi.stubEnv(key, value);
    const context = nativeRuntimeContextFixture(); context.instructions.bundle.rootPath = assets; context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    let goalSettle: string | null = null;
    const stopMode = process.env.PAPERCLIP_C1_STOP === "1"; // Stop proof: interrupt mid-stream via cancelNativeSession
    const killMode = process.env.PAPERCLIP_C1_KILL === "1"; // Kill proof: SIGKILL this process's runnerd child mid-turn
    let killResult: unknown = "not_requested";
    const prompt = killMode ? "C1 kill canary: write a 1500 word essay about lighthouses. Do not call any tool." : process.env.PAPERCLIP_C1_STEER === "1" ? "C1 steer canary: run the shell command sleep 80 and wait for it to finish. Then reply with the single word DONE, and also obey any extra instruction the owner sent while you waited." : process.env.PAPERCLIP_C1_TOOLS === "1" ? "C1 tools canary: create the file c1-tool.txt in the current directory containing exactly the word OK using a file edit, then run the shell command cat c1-tool.txt, then reply with the single word DONE." : stopMode ? "C1 stop canary: write a 1500 word essay about lighthouses. Do not call any tool." : "C1 canary: reply with the single word OK. Do not call any tool.";
    let stopResult: unknown = "not_requested";
    const execution = buildNativeExecutionInput({ companyId, runId, agentId, issue: { id: issueId, identifier: "CCA-1", title: "C1 canary (disposable)", description: null, workMode: "standard" }, taskPrompt: prompt, workspace: { id: workspaceId, cwd: workspace, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: sessionId, provider: "codex", model: MODEL, codexReasoningEffort: EFFORT, completionContract: { id: contractId, sha256: sha, schemaVersion: "v1", contract: { revision: "c1", objective: "C1 canary", criteria: [{ id: "c", requirement: "Reply OK" }] } }, runtimeContext: context });
    const sessionRow = async () => (await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId)))[0];
    const activeMode = process.env.PAPERCLIP_C1_ACTIVE === "1"; // ACTIVE proof: paused create with budget, then runtime resume (no plain turn)
    const ACTIVE_OBJECTIVE = "C1 active canary: reply with the single word OK, then stop. Do not call any tool.";
    const goalAction = async (action: "create" | "edit" | "pause" | "resume", objective: string, expectedRevision: number, tokenBudget?: number) => {
      const session = (await sessionRow())!;
      const requestId = randomUUID(), request = { requestId, agentId, action, objective, expectedRevision, ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
      await db.insert(agentSessionGoalActions).values({ companyId, sessionId: session.id, requestId, action, payloadJson: request, resultJson: {} });
      await db.update(agentTaskSessions).set({ goalRevision: expectedRevision + 1 }).where(eq(agentTaskSessions.id, session.id));
      const dispatched = dispatchLiveRunnerGoalControl({ companyId, issueId, agentId }, request); expect(dispatched).not.toBeNull(); await dispatched!.completion;
      try {
        await vi.waitFor(async () => { const [row] = await db.select().from(agentSessionGoalActions).where(eq(agentSessionGoalActions.requestId, requestId)); expect((row!.resultJson as any).codexSharedGoalV1).toMatchObject({ state: "source_receipted", sourceStatus: action === "resume" ? "active" : "paused" }); }, { timeout: 8000, interval: 50 });
      } catch (error) { const [row] = await db.select().from(agentSessionGoalActions).where(eq(agentSessionGoalActions.requestId, requestId)); process.stdout.write("C1_GOAL_ACTION_ROW " + JSON.stringify(row?.resultJson ?? null).slice(0, 1800) + "\n"); throw error; }
    };
    let safetyPause: ReturnType<typeof setTimeout> | undefined, safetyPaused = false;
    let wired = false, projectedEdit: boolean | null = null;
    const result = executePaperclipNativeSession({
      db, execution, runnerInstanceId, useRunnerd: true, ...(activeMode ? { sessionGoalControl: { requestId: randomUUID(), action: "resume" as const }, applySessionGoalControl: async () => { await vi.waitFor(async () => { expect(((await sessionRow())!.goalJson as any)?.status).toBe("paused"); }, { timeout: 8000, interval: 100 }); await new Promise((resolve) => setTimeout(resolve, 1500)); await goalAction("resume", ACTIVE_OBJECTIVE, (await sessionRow())!.goalRevision); } } : {}), adapterType: "paperclip_runner", turnTimeoutMs: 120_000,
      onEvent: async (event) => {
        // Trace of the goal projection: which provider/PRP events reach the executor (answers the goal.updated question).
        if (event.eventType.startsWith("session.goal") || event.eventType.startsWith("goal")) { goalEvents.push(event.eventType + ":" + JSON.stringify((event.payload as any)?.goal?.status ?? (event.payload as any)?.status ?? null)); if (!activeMode && /active/.test(goalEvents[goalEvents.length - 1]!)) violations.push("goal_active"); }
        if (event.eventType === "turn.started") turnStarts.push(event.eventType);
        if (killMode && event.eventType === "turn.started" && killResult === "not_requested") { killResult = "requested"; void promisify(execFile)("pgrep", ["-P", String(process.pid), "-f", "paperclip-runnerd"]).then(({ stdout }) => { const pid = Number(stdout.trim().split("\n")[0]); if (!Number.isInteger(pid) || pid <= 1) throw new Error("no_runnerd_child"); process.kill(pid, "SIGKILL"); killResult = { killedPid: pid }; }).catch((error) => { killResult = "error:" + String(error?.message ?? error); }); }
        if (stopMode && event.eventType === "turn.started" && stopResult === "not_requested") { stopResult = "requested"; void (activeMode ? settleLiveRunnerGoalBeforeInterrupt(db, { companyId, issueId, agentId }).then((r) => { goalSettle = r; }, (error: unknown) => { goalSettle = "error:" + String((error as Error)?.message ?? error).slice(0, 300); }) : Promise.resolve()).then(() => cancelNativeSession(runId, "owner_stop")).then((value) => { stopResult = value; }, (error) => { stopResult = "error:" + String(error?.message ?? error); }); }
        if (/^tool\./.test(event.eventType) || /tool_call/.test(event.eventType)) tools.push(event.eventType);
      },
      onUsage: async (receipt) => { usage.push(receipt); },
      onCodexSharedSessionReady: async () => { wired = true; if (activeMode) { await goalAction("create", ACTIVE_OBJECTIVE, 0, 15000); safetyPause = setTimeout(() => { safetyPaused = true; void sessionRow().then((row) => goalAction("pause", ACTIVE_OBJECTIVE, row!.goalRevision)).catch(() => undefined); }, 90_000); } else if (!ownerMode) await goalAction("create", "initial goal", 0); },
      onCodexSharedEventConsumerReady: async () => {
        if (ownerMode) return; // plain-turn proof: a paused goal would make the runtime yield before the turn completes
        const session = (await sessionRow())!;
        await vi.waitFor(async () => { const row = (await sessionRow())!; expect((row.goalJson as any)?.objective).toBe("initial goal"); expect((row.goalJson as any)?.status).toBe("paused"); }, { timeout: 8000, interval: 50 });
        await goalAction("edit", "edited goal", (await sessionRow())!.goalRevision);
        expect(session).toBeTruthy();
        // Projection trace: does the edit's session.goal.updated reach goalJson (soft wait, recorded not asserted)?
        projectedEdit = await vi.waitFor(async () => { expect(((await sessionRow())!.goalJson as any)?.objective).toBe("edited goal"); }, { timeout: 6000, interval: 100 }).then(() => true, () => false);
        if (!ownerMode) throw new Error("harness_stop_before_turn");
      },
    });
    if (!ownerMode) { await expect(result).rejects.toThrow("harness_stop_before_turn"); expect(wired).toBe(true); expect(turnStarts).toHaveLength(0); const persisted = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).map((row) => `${row.seq}:${row.eventType}`); process.stdout.write(`C1_PERSISTED ${JSON.stringify(persisted)}\n`); process.stdout.write(`C1_WIRE projectedEdit=${projectedEdit} projection=${JSON.stringify(projected)} goalEvents=${JSON.stringify(goalEvents)}\n`); return; }
    // Owner mode: exactly one turn. Whatever the outcome, no retry; failures are asserted below, not repeated.
    const outcome = await result.then((value) => ({ value, error: null as unknown }), (error) => ({ value: null, error }));
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const started = rows.filter((row) => row.eventType === "turn.started");
    const finalSession = await sessionRow();
    clearTimeout(safetyPause);
    // Heartbeat-layer close (PAPERCLIP_C1_FINALIZE=1): terminal projection, completion decision, issue comment, accounting rows.
    let finalize: Record<string, unknown> | null = null;
    if (process.env.PAPERCLIP_C1_FINALIZE === "1" && !outcome.error) {
      const finalizeError = await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true }).then(() => null, (error: unknown) => String((error as Error)?.stack ?? error).slice(0, 900));
      const accountError = await accountRunCost(db, runId).then(() => null, (error: unknown) => String((error as Error)?.message ?? error).slice(0, 400));
      const [closedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      finalize = { finalizeError, accountError, pending: closedRun?.costAccountingPending, accountedAt: closedRun?.costAccountedAt, usageKeys: Object.keys((closedRun?.usageJson as object) ?? {}), runStatus: closedRun?.status, runError: closedRun?.error, issueStatus: (await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status, comments: (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).map((c) => String(c.body).slice(0, 200)), decisions: (await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId))).map((d) => ({ s: (d as any).status, k: (d as any).kind })), costRows: (await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).length };
    }
    const proof = { goalSettle, finalize, killMode, killResult, finalizationRow: (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0] ?? null, activeMode, safetyPaused, stopMode, stopResult, outcomeError: outcome.error ? String((outcome.error as Error).message ?? outcome.error) : null, turnStartsObserved: turnStarts.length, turnStartedRows: started.length, runEventTypes: [...new Set(rows.map((row) => row.eventType))], goalEvents, tools, usageCheckpoints: usage.length, goalAfterTurn: finalSession?.goalJson ?? null, issueStatus: (await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status, runStatus: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status, runDetail: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.resultJson ?? null, eventTrace: rows.map((row) => `${row.seq}:${row.eventType}:${JSON.stringify(row.payload ?? null).slice(0, row.eventType === "harness.diagnostic" ? 600 : 220)}`), outcomeSettlement: (outcome.error as any)?.settlement ?? null, outcomeStack: String((outcome.error as Error)?.stack ?? "").split("\n").filter((l) => l.trimStart().startsWith("at ")).slice(0, 14).join("\n"), outcomeCause: String(((outcome.error as any)?.cause?.message) ?? "").slice(0, 300) };
    await writeFile(join(root, "c1-proof.json"), JSON.stringify({ proof, usage }, null, 2));
    process.stdout.write(`C1_PROOF ${join(root, "c1-proof.json")}\n`);
    if (!activeMode && (turnStarts.length > 1 || started.length > 1)) violations.push("second_turn");
    if (tools.length > 0) violations.push("tool_call_outside_grant");
    const status = (finalSession?.goalJson as any)?.status; if (!activeMode && status && status !== "paused") violations.push("goal_not_paused");
    expect(violations).toEqual([]);
    if (!activeMode) expect(turnStarts).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs(); runnerPrpWebSocketInternals.resetForTests(); await new Promise<void>((resolve) => server.close(() => resolve()));
    // The owner daemon is never stopped; only the throwaway isolated daemon is.
    if (!ownerMode) await exec(cli, ["app-server", "daemon", "stop"], { cwd: root, env, timeout: 15000 });
    await db.$client.end(); await database.cleanup();
  }
}, 240_000);
