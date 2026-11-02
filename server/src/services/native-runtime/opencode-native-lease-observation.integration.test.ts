import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { agentTaskSessions, agents, companies, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { readOpenCodeHost } from "./opencode-shared-recovery.js";

describeEmbeddedPostgres("native OpenCode observation under a real lease", () => {
  const ctx = useEmbeddedPostgres("paperclip-opencode-native-observer-");
  it.runIf(process.platform === "darwin")("renders owned events and denies stale binding and lease", async () => {
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-native-lease-");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "71".repeat(32));
    const host = await startOpenCodeSharedHost({ executable: "/opt/homebrew/bin/opencode", dataRoot: root, workspaceCwd: root, provider: { provider: "fixture", model: "model", baseURL: "http://127.0.0.1:1/v1", token: "f".repeat(43) }, mcp: { tools: [], createHandler: () => async () => { throw new Error("not_admitted"); } } });
    try {
      const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
      const controller = await currentNativeControllerIdentity();
      const binding = { companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId, providerSessionId: `ses_${randomUUID()}`, generation: host.generation, epoch: randomUUID(), version: "2.2.5" as const, model: "fixture/model", effort: "high", leaseOwner: "fixture-lease", leaseAttempt: 1, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 };
      await ctx.db.insert(companies).values({ id: companyId, name: "Native observer", issuePrefix: "NOB" });
      await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
      await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue" });
      await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native" });
      await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await ctx.db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: {} });
      await ctx.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: binding.leaseOwner, attempt: 1, leaseExpiresAt: new Date(Date.now() + 120_000), controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 });
      await host.createManagedSession(ctx.db, binding);
      const secret = await readOpenCodeHost(ctx.db, binding);
      const origin = `http://127.0.0.1:${secret.host.port}`;
      const authorization = `Basic ${Buffer.from(`opencode:${secret.password}`).toString("base64")}`;
      const ingress = await host.startScopedIngress(ctx.db, binding);
      const readerHeaders = { authorization: `Bearer ${ingress.readerToken}` };
      const inspect = await Promise.all([`/api/session/${binding.providerSessionId}`, `/api/session?limit=200&order=desc&parentID=${binding.providerSessionId}`, "/api/location", "/api/info"].map(async path => ({ path: path.replace(binding.providerSessionId, ":owned"), status: (await fetch(`${ingress.origin}${path}`, { headers: readerHeaders, signal: AbortSignal.timeout(10000) })).status })));
      process.stdout.write(`native-managed-bootstrap ${JSON.stringify(inspect)}\n`);
      expect(inspect.map(item => item.status)).toEqual([200, 200, 200, 200]);
      await expect(host.startScopedIngress(ctx.db, { ...binding, epoch: randomUUID() })).rejects.toThrow("binding_mismatch");
      await expect(host.startScopedIngress(ctx.db, { ...binding, projectId: randomUUID() })).rejects.toThrow();
      const requireRunner = createRequire(resolve(import.meta.dirname, "../../../../packages/paperclip-runner/package.json"));
      const pty = requireRunner("node-pty") as typeof import("node-pty");
      const terminals = [0, 1].map(() => pty.spawn("/opt/homebrew/bin/opencode", ["--server", ingress.origin, "--session", binding.providerSessionId], { cwd: root, cols: 120, rows: 40, env: { PATH: "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", OPENCODE_PASSWORD: ingress.readerToken } }));
      const screens = ["", ""];
      const exits = terminals.map((terminal, index) => { terminal.onData(data => { screens[index] = (screens[index] + data).slice(-500_000); }); return new Promise<void>(resolveExit => terminal.onExit(() => resolveExit())); });
      try {
        await new Promise(resolveWait => setTimeout(resolveWait, 6500));
        const rename = async (title: string) => fetch(`${origin}/api/session/${binding.providerSessionId}`, { method: "PATCH", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ title }), signal: AbortSignal.timeout(5000) });
        expect((await rename("LEASE-OWNED-VISIBLE")).status).toBe(204);
        await new Promise(resolveWait => setTimeout(resolveWait, 4000));
        process.stdout.write(`native-managed-tui ${JSON.stringify(screens.map(screen => ({ rendered: screen.includes("LEASE-OWNED-VISIBLE"), tail: screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-500) })))}\n`);
        expect(screens.map(screen => screen.includes("LEASE-OWNED-VISIBLE"))).toEqual([true, true]);
        await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: "revoked" }).where(eq(nativeRunFinalizations.runId, runId));
        expect((await rename("LEASE-REVOKED-MUST-NOT-ARRIVE")).status).toBe(204);
        await new Promise(resolveWait => setTimeout(resolveWait, 1000));
        expect(screens.map(screen => screen.includes("LEASE-REVOKED-MUST-NOT-ARRIVE"))).toEqual([false, false]);
        expect((await fetch(`${ingress.origin}/api/session/${binding.providerSessionId}`, { headers: { authorization: `Bearer ${ingress.readerToken}` } })).status).toBe(503);
        await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: binding.leaseOwner }).where(eq(nativeRunFinalizations.runId, runId));
        const [saved] = await ctx.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
        const params = saved!.sessionParamsJson as Record<string, any>;
        const foreignProject = randomUUID();
        await ctx.db.insert(projects).values({ id: foreignProject, companyId, name: "Foreign" });
        const rejectNext = async (change: () => Promise<unknown>, restore: () => Promise<unknown>, title: string) => {
          const response = await fetch(`${ingress.origin}/api/event`, { headers: readerHeaders, signal: AbortSignal.timeout(15000) });
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          try {
            expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected");
            await change();
            expect((await rename(title)).status).toBe(204);
            const outcome = await reader.read().then(value => value.done ? "closed" : new TextDecoder().decode(value.value), () => "closed");
            expect(outcome).toBe("closed");
          } finally { await restore(); await reader.cancel().catch(() => {}); }
        };
        await rejectNext(() => ctx.db.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...params.opencodeSharedV2, epoch: randomUUID() } } }).where(eq(agentTaskSessions.id, taskSessionId)), () => ctx.db.update(agentTaskSessions).set({ sessionParamsJson: params }).where(eq(agentTaskSessions.id, taskSessionId)), "STALE-EPOCH-MUST-NOT-ARRIVE");
        await rejectNext(() => ctx.db.update(issues).set({ projectId: foreignProject }).where(eq(issues.id, issueId)), () => ctx.db.update(issues).set({ projectId }).where(eq(issues.id, issueId)), "FOREIGN-PROJECT-MUST-NOT-ARRIVE");
      } finally { terminals.forEach(terminal => terminal.kill()); await Promise.race([Promise.all(exits), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_tui_exit_unconfirmed")), 5000))]); await ingress.close(); }
    } finally { await host.shutdown(); vi.unstubAllEnvs(); }
  }, 60_000);
});
