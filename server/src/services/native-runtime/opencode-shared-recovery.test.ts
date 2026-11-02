import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { agentTaskSessions, agents, companies, companySecretVersions, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";

const state = vi.hoisted(() => ({ secret: "", controller: { pid: 4, bootId: "boot", processStartedAt: new Date(1) }, created: 0, actualService: null as null | ((db: any) => any) }));
vi.mock("./native-restart-recovery.js", () => ({ currentNativeControllerIdentity: async () => state.controller }));
vi.mock("../secrets.js", () => ({ secretService: (db: unknown) => state.actualService ? state.actualService(db) : ({
  create: async (_company: string, input: { value: string }) => { state.secret = input.value; state.created++; return { id: "secret-ref", latestVersion: 1 }; },
  resolveSecretValue: async () => state.secret,
}) }));
import { persistOpenCodeHost, readOpenCodeHost, readOpenCodeHostRestoration, reserveOpenCodeMcpRestoration } from "./opencode-shared-recovery.js";
import { createOpenCodeManagedMutation } from "./opencode-managed-mutation.js";

const binding: OpenCodeSharedBinding = { companyId: "company", projectId: "project", issueId: "issue", agentId: "agent", runId: "run", taskSessionId: "task", normalizedSessionId: "native", runnerInstanceId: "runner", providerSessionId: "ses_test", generation: "generation", epoch: "epoch", version: "2.2.5", model: "model", effort: "high", leaseOwner: "lease", leaseAttempt: 1, controllerBootId: "boot", controllerPid: 4, controllerProcessStartedAt: new Date(1), controllerGeneration: 1 };
const host = { pid: 100, startedAt: new Date(2).toISOString(), executable: "/opt/opencode", port: 1234, namespace: "/safe/namespace", generation: "generation", password: "private-fixture" };
function fixture() {
  let params: Record<string, unknown> = { opencodeSharedV2: { ...binding, cursor: null } };
  let lease = true;
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    let n = 0; let staged = params;
    const rows = [lease ? [{}] : [], [{}], [{}], [{ id: "task", sessionParamsJson: params }], lease ? [{}] : []];
    const tx = { select: () => { const result = rows[n++] ?? []; const chain = { from: () => chain, where: () => chain, for: () => chain, limit: async () => result }; return chain; }, update: () => ({ set: (value: { sessionParamsJson: Record<string, unknown> }) => ({ where: async () => { staged = value.sessionParamsJson; } }) }) };
    const result = await fn(tx); params = staged; return result;
  } };
  return { db: db as never, get params() { return params; }, expire: () => { lease = false; }, changeGeneration: () => { (params.opencodeSharedV2 as Record<string, unknown>).generation = "foreign"; } };
}
beforeEach(() => { state.secret = ""; state.created = 0; state.controller = { pid: 4, bootId: "boot", processStartedAt: new Date(1) }; });
describe("OpenCode host recovery", () => {
  it("recovers an encrypted-secret reference and identity after controller memory is lost", async () => {
    const f = fixture(); await persistOpenCodeHost(f.db, binding, host);
    expect(JSON.stringify(f.params)).not.toContain(host.password);
    expect(await readOpenCodeHost(f.db, binding)).toEqual({ host: expect.objectContaining({ pid: 100, generation: "generation", secretId: "secret-ref" }), password: host.password });
    await expect(persistOpenCodeHost(f.db, binding, host)).rejects.toThrow("host_exists");
  });
  it("rejects foreign controllers, lost lease and changed binding before saving credentials", async () => {
    const f = fixture(); state.controller = { ...state.controller, bootId: "foreign" };
    await expect(persistOpenCodeHost(f.db, binding, host)).rejects.toThrow("foreign_controller");
    state.controller = { ...state.controller, bootId: "boot" }; f.expire();
    await expect(persistOpenCodeHost(f.db, binding, host)).rejects.toThrow("lease_lost");
    const g = fixture(); g.changeGeneration(); await expect(persistOpenCodeHost(g.db, binding, host)).rejects.toThrow("binding_mismatch");
    expect(state.created).toBe(0);
  });
  it("stores restoration credentials only in the secret provider and requires the exact lease", async () => {
    const f = fixture(), proxy = { baseURL: "http://127.0.0.1:4567/v1", token: "a".repeat(43) };
    await persistOpenCodeHost(f.db, binding, { ...host, proxy });
    expect(JSON.stringify(f.params)).not.toContain(proxy.token);
    expect(await readOpenCodeHostRestoration(f.db, binding)).toEqual({ host: expect.objectContaining({ secretId: "secret-ref" }), password: host.password, proxy });
    (f.params.opencodeSharedV2 as Record<string, unknown>).mutations = [{ id: "msg_unknown", state: "reserved" }];
    await expect(readOpenCodeHostRestoration(f.db, binding)).rejects.toThrow("outcome_unknown");
    (f.params.opencodeSharedV2 as Record<string, unknown>).mutations = [{ id: "msg_acked", state: "acknowledged" }];
    await expect(readOpenCodeHostRestoration(f.db, binding)).rejects.toThrow("outcome_unknown");
    delete (f.params.opencodeSharedV2 as Record<string, unknown>).mutations;
    (f.params.opencodeSharedV2 as Record<string, unknown>).semanticCalls = [{ state: "reserved" }];
    await expect(readOpenCodeHostRestoration(f.db, binding)).rejects.toThrow("outcome_unknown");
    f.expire();
    await expect(readOpenCodeHostRestoration(f.db, binding)).rejects.toThrow("lease_lost");
  });
  it("never repeats an MCP replacement with an unknown acknowledgement", async () => {
    const f = fixture(), digest = "a".repeat(64);
    await reserveOpenCodeMcpRestoration(f.db, binding, digest);
    expect(f.params).toMatchObject({ opencodeSharedV2: { mcpRestoration: { digest, state: "reserved" } } });
    await expect(reserveOpenCodeMcpRestoration(f.db, binding, digest)).rejects.toThrow("outcome_unknown");
  });
  it("rejects a foreign persisted generation before releasing restoration material", async () => {
    const f = fixture();
    await persistOpenCodeHost(f.db, binding, { ...host, proxy: { baseURL: "http://127.0.0.1:4567/v1", token: "a".repeat(43) } });
    f.changeGeneration();
    await expect(readOpenCodeHostRestoration(f.db, binding)).rejects.toThrow("binding_mismatch");
  });
});

describeEmbeddedPostgres("OpenCode host recovery lease transaction", () => {
  const ctx = useEmbeddedPostgres("paperclip-opencode-recovery-");
  it("persists under the real exact lease and rejects a stale lease after recovery", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const b: OpenCodeSharedBinding = { ...binding, companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId };
    await ctx.db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: "OCR" });
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
    await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue" });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native" });
    await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await ctx.db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: "task", lastRunId: runId, sessionParamsJson: {} });
    await ctx.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: b.leaseOwner, attempt: b.leaseAttempt, leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: b.controllerBootId, controllerPid: b.controllerPid, controllerProcessStartedAt: b.controllerProcessStartedAt, controllerGeneration: b.controllerGeneration });
    const actual = await vi.importActual<typeof import("../secrets.js")>("../secrets.js");
    state.actualService = actual.secretService;
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    try {
      await persistOpenCodeHost(ctx.db, b, host);
      const restored = await readOpenCodeHost(ctx.db, b);
      expect(restored.host.generation).toBe(b.generation); expect(restored.password).toBe(host.password);
      const encrypted = await ctx.db.select().from(companySecretVersions);
      expect(JSON.stringify(encrypted)).not.toContain(host.password);
      await expect(readOpenCodeHost(ctx.db, { ...b, leaseOwner: "foreign" })).rejects.toThrow("lease_lost");
      await expect(readOpenCodeHost(ctx.db, { ...b, epoch: "foreign" })).rejects.toThrow("binding_mismatch");
      let posts = 0;
      const server = createServer((req, res) => {
        if (req.headers.authorization !== "Basic fixture") { res.writeHead(401).end(); return; }
        if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { id: b.providerSessionId } })); return; }
        posts++;
        if (posts === 2) { req.socket.destroy(); return; }
        let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { const parsed = JSON.parse(body); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: { id: parsed.id, sessionID: b.providerSessionId, type: "user" } })); });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const make = () => createOpenCodeManagedMutation(ctx.db, { binding: b, admission: { baseUrl, authorization: "Basic fixture", attest: async () => {} } });
        expect(await make().dispatch({ id: "msg_first", text: "fixture" })).toEqual({ delivery: "acknowledged", taskCompletion: "unproven" });
        await expect(make().dispatch({ id: "msg_first", text: "fixture" })).rejects.toThrow("already_recorded");
        await expect(make().dispatch({ id: "msg_first", text: "changed" })).rejects.toThrow("digest_mismatch");
        await expect(make().dispatch({ id: "msg_lost", text: "fixture" })).rejects.toThrow();
        await expect(make().dispatch({ id: "msg_after_crash", text: "fixture" })).rejects.toThrow("outcome_unknown");
        expect(posts).toBe(2);
        // The provider helper itself does not release or replace durable run ownership.
        // The executor/heartbeat failure-disposition path still requires its own test.
        const [run] = await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const [issue] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
        const [lease] = await ctx.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
        const [session] = await ctx.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
        expect(run.status).toBe("running");
        expect(issue.executionRunId).toBe(runId);
        expect(lease).toMatchObject({ phase: "running", leaseOwner: b.leaseOwner, attempt: b.leaseAttempt, controllerGeneration: b.controllerGeneration });
        expect(session.lastRunId).toBe(runId);
        await expect(readOpenCodeHostRestoration(ctx.db, b)).rejects.toThrow("outcome_unknown");
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    } finally { state.actualService = null; vi.unstubAllEnvs(); }
  });
});
