import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { agentTaskSessions, agents, companies, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { persistOpenCodeHost } from "./opencode-shared-recovery.js";
import { createOpenCodeMcpAdmission } from "./opencode-mcp-admission.js";

describeEmbeddedPostgres("OpenCode MCP peer admission", () => {
  const ctx = useEmbeddedPostgres("paperclip-opencode-mcp-");
  it.skipIf(process.platform !== "darwin")("requires the exact daemon socket and a current lease", async () => {
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-mcp-peer-");
    await mkdir(join(root, "work"));
    const child = spawn(process.execPath, ["-e", `process.stdin.on('data', b => { const p=Number(b); require('http').get({host:'127.0.0.1',port:p,path:'/'}, r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===204?0:2))}).on('error',()=>process.exit(3)); });`], { cwd: join(root, "work"), stdio: ["pipe", "ignore", "ignore"] });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "92".repeat(32));
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const pid = child.pid!;
      const startedAt = (await readProcessStartedAt(pid))!;
      const executable = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
      const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
      const controller = await currentNativeControllerIdentity();
      const binding = { companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId, providerSessionId: "ses_exact", generation: randomUUID(), epoch: randomUUID(), version: "2.2.5" as const, model: "fixture", effort: "fixture", leaseOwner: "lease", leaseAttempt: 1, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 };
      await ctx.db.insert(companies).values({ id: companyId, name: "MCP", issuePrefix: "MCP" });
      await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
      await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue" });
      await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native" });
      await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await ctx.db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: {} });
      await ctx.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: "lease", attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 });
      await persistOpenCodeHost(ctx.db, binding, { pid, startedAt, executable, port: 12345, namespace: root, generation: binding.generation, password: "fixture-only" });
      const admit = createOpenCodeMcpAdmission(ctx.db, binding);
      await expect(admit({ sessionId: "ses_foreign", remoteAddress: "127.0.0.1", remotePort: 1, localAddress: "127.0.0.1", localPort: 2 })).rejects.toThrow("denied");
      server = createServer((req, res) => { const s = req.socket; void admit({ sessionId: "ses_exact", remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! }).then(() => res.writeHead(204).end(), () => res.writeHead(403).end()); });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture server unavailable");
      const foreign = await fetch(`http://127.0.0.1:${address.port}`); expect(foreign.status).toBe(403);
      child.stdin.end(String(address.port));
      expect(await new Promise<number | null>(resolve => child.once("exit", resolve))).toBe(0);
      await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: "successor" }).where(eq(nativeRunFinalizations.runId, runId));
      await expect(admit({ sessionId: "ses_exact", remoteAddress: "127.0.0.1", remotePort: 1, localAddress: "127.0.0.1", localPort: 2 })).rejects.toThrow("lease_lost");
    } finally { if (child.exitCode === null) child.kill(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); vi.unstubAllEnvs(); }
  }, 30_000);
});
