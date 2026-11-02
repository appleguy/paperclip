import { createServer, type Server } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readProcessStartedAt } from "../hot-restart.js";
import { inspectOpenCodeRestartClaim } from "./opencode-restart-claim.js";
import { readOpenCodeHost } from "./opencode-shared-recovery.js";
import { claimNativeRestartRecoveries, currentNativeControllerIdentity, nextNativeProviderAttempt } from "./native-restart-recovery.js";
import { agentTaskSessions, agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { describeEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

describe.runIf(process.platform === "darwin")("saved OpenCode restart evidence", () => {
  let listener: Server;
  let fixture: Record<string, any>;
  beforeAll(async () => {
    listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    const executable = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "comm="], { encoding: "utf8" }).trim();
    const host = { pid: process.pid, port, startedAt: await readProcessStartedAt(process.pid), executable, namespace: process.cwd(), workingDirectory: process.cwd(), generation: "generation", secretId: "secret", secretVersion: 1 };
    const run = { id: "run", companyId: "company", agentId: "agent", nativeSessionId: "native", runnerInstanceId: "runner", runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode_shared_v2", cliVersion: "2.2.5", model: "provider/model", effort: "high" }, session: { driverKind: "opencode_shared_v2", normalizedSessionId: "native" }, binding: { companyId: "company", issueId: "issue", agentId: "agent", runId: "run" } } } };
    const native = { companyId: "company", projectId: "project", issueId: "issue", agentId: "agent", runId: "run", taskSessionId: "task", normalizedSessionId: "native", runnerInstanceId: "runner", version: "2.2.5", model: "provider/model", effort: "high", providerSessionId: "ses_test", generation: "generation", epoch: "epoch", cursor: null, host, sessionCreation: { state: "observed", sessionId: "ses_test", model: "provider/model", effort: "high", workingDirectory: process.cwd() } };
    fixture = { run, native };
  });
  afterAll(async () => { await new Promise<void>(resolve => listener.close(() => resolve())); });
  function inspect(native = structuredClone(fixture.native), run = structuredClone(fixture.run)) {
    const rows = [{ id: "task", sessionParamsJson: { opencodeSharedV2: native } }];
    const db = { select: () => ({ from: () => ({ where: () => ({ for: async () => rows }) }) }) };
    return inspectOpenCodeRestartClaim(db as never, run as never, "issue", "project");
  }
  it("accepts exact live process metadata only as observation evidence", async () => {
    expect(await inspect()).toEqual({ kind: "saved", taskSessionId: "task", generation: "generation", epoch: "epoch" });
  });
  it("holds altered identity, prior work and uncertain MCP instead of generic fallback", async () => {
    for (const alter of [
      (n: any) => { n.host.generation = "foreign"; },
      (n: any) => { n.epoch = ""; },
      (n: any) => { n.host.pid = 99999999; },
      (n: any) => { n.host.port++; },
      (n: any) => { n.mutations = [{ state: "reserved" }]; },
      (n: any) => { n.semanticCalls = [{ state: "reserved" }]; },
      (n: any) => { n.mcpRestoration = { state: "reserved" }; },
    ]) {
      const native = structuredClone(fixture.native); alter(native);
      expect((await inspect(native)).kind).toBe("hold");
    }
  });
});

describeEmbeddedPostgres("OpenCode existing recovery claim", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("opencode-restart-claim-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  it.runIf(process.platform === "darwin")("takes over the actual durable lease from a distinct OS successor and fences the old owner", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const controller = await currentNativeControllerIdentity();
    expect(execFileSync("/opt/homebrew/bin/opencode", ["--version"], { encoding: "utf8" }).trim()).toBe("opencode v2.2.5");
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-claim-native-");
    for (const dir of ["home", "config", "data", "cache", "state", "work"]) await mkdir(resolve(root, dir));
    const cwd = resolve(root, "work"), password = randomUUID();
    const config = { providers: { paperclip: { package: "@opencode/ai/providers/openai-compatible", name: "paperclip", settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "{env:PAPERCLIP_PROVIDER_TOKEN}" }, models: { "fixture-model": { name: "fixture-model" } } } } };
    const server = spawn("/opt/homebrew/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: resolve(root, "home"), XDG_CONFIG_HOME: resolve(root, "config"), XDG_DATA_HOME: resolve(root, "data"), XDG_CACHE_HOME: resolve(root, "cache"), XDG_STATE_HOME: resolve(root, "state"), OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PAPERCLIP_PROVIDER_TOKEN: "fixture" } });
    server.stderr.resume();
    const exitedServer = new Promise<void>(resolveExit => server.once("exit", () => resolveExit()));
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        let buffer = ""; const timer = setTimeout(() => reject(new Error("native_start_timeout")), 10_000);
        server.once("error", reject); server.once("exit", () => reject(new Error("native_start_failed")));
        server.stdout.on("data", chunk => { buffer += String(chunk); const found = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (found) { clearTimeout(timer); buffer = ""; resolvePort(Number(found[1])); server.stdout.resume(); } });
      });
      const pid = server.pid!, executable = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
      const host = { pid, port, startedAt: await readProcessStartedAt(pid), executable, namespace: root, workingDirectory: cwd, generation: "generation", secretId: "secret", secretVersion: 1 };
      const binding = { companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId, version: "2.2.5" as const, model: "paperclip/fixture-model", effort: "high", providerSessionId: `ses_${randomUUID()}`, generation: "generation", epoch: "epoch" };
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }, origin = `http://127.0.0.1:${port}`;
      const created = await fetch(`${origin}/api/session`, { method: "POST", headers, body: JSON.stringify({ id: binding.providerSessionId, model: { providerID: "paperclip", id: "fixture-model", variant: "high" }, location: { directory: cwd } }), signal: AbortSignal.timeout(10_000) });
      expect(created.status).toBe(200);
      await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: "OCR" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
      await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode_shared_v2", cliVersion: "2.2.5", model: binding.model, effort: binding.effort }, session: { driverKind: "opencode_shared_v2", normalizedSessionId }, binding } } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: { opencodeSharedV2: { ...binding, host, cursor: null, sessionCreation: { state: "observed", sessionId: binding.providerSessionId, model: binding.model, effort: binding.effort, workingDirectory: cwd } } } });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 2, leaseOwner: "old", leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: "old", controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 3 });
      expect(await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [runId] })).toMatchObject([{ kind: "awaiting_evidence", reason: "controller_still_alive" }]);
      expect(await claimNativeRestartRecoveries({ db, controller: { ...controller, bootId: "foreign" }, restartKind: "hard", runIds: [runId] })).toMatchObject([{ kind: "awaiting_evidence", reason: "opencode_foreign_successor_controller" }]);
      const previous = spawn(process.execPath, ["-e", "process.on('message', () => process.exit(0))"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const previousStart = await readProcessStartedAt(previous.pid!);
      if (!previousStart) throw new Error("previous_controller_start_unavailable");
      await db.update(nativeRunFinalizations).set({ controllerPid: previous.pid!, controllerProcessStartedAt: new Date(previousStart) }).where(eq(nativeRunFinalizations.runId, runId));
      const exited = new Promise<void>((resolveExit, reject) => { previous.once("exit", code => code === 0 ? resolveExit() : reject(new Error("previous_controller_exit_failed"))); });
      previous.send("stop");
      await exited;
      const saved = { ...binding, host, cursor: null, sessionCreation: { state: "observed", sessionId: binding.providerSessionId, model: binding.model, effort: binding.effort, workingDirectory: cwd } };
      await db.update(agentTaskSessions).set({ sessionParamsJson: { opencodeSharedV2: { ...saved, mutations: [{ state: "reserved" }] } } }).where(eq(agentTaskSessions.id, taskSessionId));
      expect(await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [runId] })).toMatchObject([{ kind: "awaiting_evidence", reason: "opencode_restart_outcome_unknown" }]);
      await db.update(agentTaskSessions).set({ sessionParamsJson: { opencodeSharedV2: saved } }).where(eq(agentTaskSessions.id, taskSessionId));
      const child = spawn(process.execPath, ["--import", resolve(import.meta.dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(import.meta.dirname, "opencode-restart-claim-child.fixture.ts")], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const answer = await new Promise<any>((resolveAnswer, reject) => {
        child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(new Error(`successor_exit_${code}`)); });
        child.once("message", resolveAnswer); child.send({ connectionString: temporary.connectionString, runId });
      });
      expect(answer.error).toBeUndefined();
      expect(answer.controller.pid).not.toBe(process.pid);
      const [result] = answer.dispositions;
      expect(result).toMatchObject({ kind: "observe_saved_opencode_host", providerAttempt: 2, controllerGeneration: 4, savedHost: { taskSessionId, generation: binding.generation, epoch: binding.epoch } });
      expect(nextNativeProviderAttempt(2, result.kind)).toBe(2);
      const [lease] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(lease).toMatchObject({ controllerPid: answer.controller.pid, controllerBootId: answer.controller.bootId, attempt: 2, controllerGeneration: 4 });
      expect(lease!.leaseOwner).not.toBe("old");
      await expect(readOpenCodeHost(db, { ...binding, leaseOwner: "old", leaseAttempt: 2, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 3 })).rejects.toThrow("opencode_recovery_lease_lost");
      const [stored] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
      expect(stored!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { host, epoch: "epoch" } });
      const read = await fetch(`${origin}/api/session/${binding.providerSessionId}`, { headers, signal: AbortSignal.timeout(10_000) });
      expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ data: { id: binding.providerSessionId } });
    } finally { if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM"); await Promise.race([exitedServer, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_exit_unconfirmed")), 5000))]); }
  }, 60_000);
});
