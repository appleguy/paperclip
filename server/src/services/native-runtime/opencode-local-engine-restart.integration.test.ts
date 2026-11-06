import { randomUUID, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { agentTaskSessions, agents, companies, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { startOpenCodeManagedBackend } from "./opencode-managed-admission.js";
import { forgetOpenCodeManagedHost, verifyOpenCodeManagedProviderTarget } from "./opencode-host-registry.js";
import { restartOpenCodeLocalEngine, type LocalEngineIdentity } from "./opencode-local-engine-restart.js";

// The checkout contains other agents' emitted .js siblings. Use the checked-in
// source for the two changed runner exports without modifying those artifacts.
const boundaryFixture = vi.hoisted(() => ({ armed: () => {} }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => {
  const actual = await original<typeof import("../../vendor/paperclip-runner/index.js")>();
  const boundary = await import("../../../../packages/paperclip-runner/src/drivers/opencode/provider-boundary.ts");
  const proxy = await import("../../../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts");
  class TestBoundary extends boundary.OpenCodeProviderBoundary {
    override freeze(input: { timeoutMs: number; signal: AbortSignal }) {
      const result = super.freeze(input);
      boundaryFixture.armed();
      return result;
    }
  }
  return { ...actual, OpenCodeProviderBoundary: TestBoundary, startOpenCodeProviderProxy: proxy.startOpenCodeProviderProxy };
});

describeEmbeddedPostgres("local OpenCode managed admission and restart coordinator", () => {
  const ctx = useEmbeddedPostgres("opencode-local-freeze-");
  it("admits an isolated local provider and carries real tool history across its engine restart", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "71".repeat(32));
    const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-local-restart-")));
    await writeFile(join(root, "fixture.txt"), "LOCAL_RESTART_TOOL_RESULT\n");
    const requests: string[] = [];
    let engine: Server | undefined;
    async function startEngine(port = 0) {
      const server = createServer(async (req, res) => {
        if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
        if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString(); requests.push(body);
        const payload = JSON.parse(body), toolResult = payload.messages.some((m: any) => m.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (toolResult) { chunk({ role: "assistant", content: "LOCAL_RESTART_DONE" }, null); chunk({}, "stop"); }
        else { chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(root, "fixture.txt") }) } }] }, null); chunk({}, "tool_calls"); }
        res.end("data: [DONE]\n\n");
      });
      await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve)); return server;
    }
    engine = await startEngine();
    const port = (engine.address() as { port: number }).port;
    let admitted: Awaited<ReturnType<typeof startOpenCodeManagedBackend>> | undefined;
    try {
      const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
      const controller = await currentNativeControllerIdentity();
      await ctx.db.insert(companies).values({ id: companyId, name: "Local freeze", issuePrefix: "OLF" });
      await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
      await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue" });
      const execution = buildNativeExecutionInput({ companyId, runId, agentId, issue: { id: issueId, identifier: "OLF-1", title: "Issue", description: null, workMode: "standard" }, taskPrompt: "Read fixture", workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: sessionId, provider: "opencode_shared_v2", model: "paperclip/fixture", opencodeEffort: "high", completionContract: { id: "fixture", sha256: "sha256:" + "a".repeat(64), schemaVersion: "v1", contract: { revision: "1", objective: "Read fixture", criteria: [{ id: "c", requirement: "Read" }] } }, runtimeContext: nativeRuntimeContextFixture() });
      await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId, status: "running", runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution } });
      await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await ctx.db.insert(agentTaskSessions).values({ id: randomUUID(), companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: {} });
      await ctx.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: "fixture", attempt: 1, leaseExpiresAt: new Date(Date.now() + 120_000), controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 });
      admitted = await startOpenCodeManagedBackend(ctx.db, { execution, runnerInstanceId, leaseOwner: "fixture", attempt: 1, controller, executable: "/opt/homebrew/bin/opencode", dataRoot: join(root, "state"), environment: { PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`, PAPERCLIP_AI_PROVIDER_KEY: "fixture" }, authority: { definitions: () => [], execute: async () => ({}), recover: async () => ({}) } as any, completionFeedback: async () => "accepted" });
      const { binding } = admitted;
      await expect(verifyOpenCodeManagedProviderTarget(ctx.db, binding, "http://127.0.0.1:1/v1")).rejects.toThrow("provider_target_mismatch");
      let generation = "before";
      const identity: LocalEngineIdentity = { route: `http://127.0.0.1:${port}/v1`, model: "fixture", generation, modelSha256: "1".repeat(64), tokenizerSha256: "2".repeat(64), templateSha256: "3".repeat(64), executableSha256: "4".repeat(64), configSha256: "5".repeat(64) };
      let exclusive = false;
      const armed = new Promise<void>(resolve => { boundaryFixture.armed = resolve; });
      const operation = restartOpenCodeLocalEngine({ db: ctx.db, binding, expected: identity, timeoutMs: 30_000, signal: new AbortController().signal, authority: { async withExclusiveRestart(_binding, _signal, work) { if (exclusive) throw new Error("already held"); exclusive = true; try { return await work({ identity: async () => ({ ...identity, generation }), restart: async () => { await new Promise<void>(resolve => engine!.close(() => resolve())); engine = await startEngine(port); generation = "after"; } }); } finally { exclusive = false; } } } });
      await Promise.race([armed, operation.then(() => { throw new Error("restart unexpectedly completed"); })]);
      await delay(100); // Let the admission transaction release its run lock.
      await admitted.admitted.port.dispatch({ id: `msg_${randomUUID()}`, text: "Read fixture.txt." });
      const result = await operation;
      for (let i = 0; i < 100 && requests.length < 2; i++) await delay(50);
      const continued = requests.at(-1)!;
      expect(createHash("sha256").update(continued).digest("hex")).toBe(result.requestSha256);
      expect(JSON.stringify(JSON.parse(continued).messages)).toContain("LOCAL_RESTART_TOOL_RESULT");
      expect(result).toMatchObject({ previousGeneration: "before", generation: "after" });
    } finally {
      if (admitted) { forgetOpenCodeManagedHost(admitted.binding, admitted.host); await admitted.host.shutdown(); }
      if (engine?.listening) { engine.closeAllConnections(); await new Promise<void>(resolve => engine!.close(() => resolve())); }
      await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
    }
  }, 60_000);
});
