import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTaskSessions, agents, companies, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { restoreOpenCodeManagedObservation, resumeOpenCodeManagedOperation } from "./opencode-managed-lifecycle.js";
import { createOpenCodeSemanticHandler } from "./opencode-semantic-handler.js";
import { readOpenCodeTerminalReceipt, transitionOpenCodeSemanticCall } from "./opencode-shared-recovery.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { createOpenCodeNativePort } from "./opencode-native-port.js";
import { OpenCodeSharedNativeBackend, executeNativeSession, validatePrpEvent, startOpenCodeProviderProxy } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { claimOpenCodeTaskSession, loadOpenCodeSuccessorBinding } from "./opencode-managed-admission.js";
import { retainOpenCodeManagedHost, reconnectOpenCodeManagedHost, forgetOpenCodeManagedHost } from "./opencode-host-registry.js";
import { restoreOpenCodeProviderListener } from "./opencode-proxy-restoration.js";

vi.mock("./opencode-provider-profile.js", () => ({ resolveOpenCodeSharedProvider: async () => ({ provider: "fixture", model: "model", baseUrl: "http://127.0.0.1:1/v1", key: "fixture" }) }));

describeEmbeddedPostgres("OpenCode managed source-host lifecycle", () => {
  const ctx = useEmbeddedPostgres("paperclip-opencode-managed-");
  it("attests, binds and dispatches once through the real lease and encrypted host record", async () => {
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-fake-host-");
    const executable = join(root, "opencode-fixture");
    const code = `#!${process.execPath}
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('opencode v2.2.5'); process.exit(0); }
const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
const session = 'ses_fixture';
const server = http.createServer((req,res) => {
  if (req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
  if (req.url === '/api/info') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({pid:process.pid,version:'2.2.5'})); return; }
  if (req.url.startsWith('/api/provider?')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[]})); return; }
  if (req.url.startsWith('/api/provider/fixture?')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:{id:'fixture',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).providers.fixture.settings.baseURL,apiKey:process.env.PAPERCLIP_PROVIDER_TOKEN}}})); return; }
  if (req.url.startsWith('/api/model?')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:'model',providerID:'fixture',variants:[{id:'high'}]}]})); return; }
  if (req.method === 'PUT' && req.url.startsWith('/api/experimental/mcp/paperclip?')) { let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{const p=JSON.parse(raw);if(p.config?.type!=='remote'||!p.config?.url?.startsWith('http://127.0.0.1:')||!p.config?.headers?.Authorization?.startsWith('Bearer ')){res.writeHead(400).end();return}const target=new URL(p.config.url);const check=http.request(target,{method:'POST',headers:{authorization:p.config.headers.Authorization,'content-type':'application/json'}},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>{if(!JSON.parse(data).result?.isError){res.writeHead(500).end();return}res.writeHead(204).end()})});check.on('error',()=>res.writeHead(500).end());check.end(JSON.stringify({jsonrpc:'2.0',id:'denied',method:'tools/call',params:{name:'get_task_context',arguments:{},_meta:{'ai.opencode/sessionID':session}}}))}); return; }
  if (req.method === 'GET' && req.url.startsWith('/api/mcp?')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{name:'paperclip',status:{status:'connected'}}]})); return; }
  if (req.method === 'POST' && req.url === '/api/session') { let raw=''; req.on('data',c=>raw+=c); req.on('end',()=>{const p=JSON.parse(raw);if(p.id!==session||p.model?.providerID!=='fixture'||p.model?.id!=='model'||p.model?.variant!=='high'||p.location?.directory!==process.cwd()){res.writeHead(400).end();return} const target = new URL(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.servers.paperclip.url); const call = http.request(target,{method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_MCP_TOKEN,'content-type':'application/json'}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>{if(!JSON.parse(body).result?.isError){res.writeHead(500).end();return} res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:session}}));})}); call.on('error',()=>res.writeHead(500).end()); call.end(JSON.stringify({jsonrpc:'2.0',id:'unbound',method:'tools/call',params:{name:'get_task_context',arguments:{},_meta:{'ai.opencode/sessionID':session}}}));}); return; }
  if (req.method === 'GET' && req.url === '/api/session/' + session) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:{id:session,location:{directory:process.cwd()},model:{providerID:'fixture',id:'model',variant:'high'}}})); return; }
  if (req.url.startsWith('/api/experimental/session/')) { res.setHeader('content-type','text/event-stream'); res.write('data: ' + JSON.stringify({id:'evt_fixture',type:'session.tool.called',data:{sessionID:session,assistantMessageID:'msg_fixture',id:'tool_fixture',input:{},executed:true},durable:{aggregateID:session,seq:1,version:1}}) + '\\n\\n'); res.write('data: ' + JSON.stringify({type:'log.synced',aggregateID:session,seq:1}) + '\\n\\n'); return; }
  if (req.method === 'POST' && req.url === '/api/session/' + session + '/prompt') { let body=''; req.on('data', c => body += c); req.on('end', () => { const msg=JSON.parse(body); const target = new URL(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.servers.paperclip.url); const call = http.request(target, {method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_MCP_TOKEN,'content-type':'application/json'}}, r=>{let body='';r.on('data', c=>body+=c);r.on('end',()=>{if(JSON.parse(body).result?.isError){res.writeHead(500).end();return} res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{id:msg.id,sessionID:session,type:'user'}}));})}); call.on('error',()=>res.writeHead(500).end()); call.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,method:'tools/call',params:{name:'get_task_context',arguments:{},_meta:{'ai.opencode/sessionID':session}}})); }); return; }
  res.writeHead(404).end();
});
server.listen(0,'127.0.0.1',() => console.log('server listening on http://127.0.0.1:' + server.address().port));
`;
    await writeFile(executable, code, { mode: 0o700 }); await chmod(executable, 0o700);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "91".repeat(32));
    const execute = vi.fn(async (call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> => { throw new Error(`unbound authority: ${call.tool}`); });
    const proxy = await startOpenCodeProviderProxy("http://127.0.0.1:1/v1", "fixture", "model", {});
    const host = await startOpenCodeSharedHost({ executable, dataRoot: join(root, "state"), workspaceCwd: root, provider: { provider: "fixture", model: "model", baseURL: proxy.baseURL, token: proxy.token }, onShutdown: proxy.close, mcp: {
      tools: [{ name: "get_task_context", inputSchema: { type: "object" } }],
      createHandler: binding => { const authority = new PaperclipRunnerToolAuthority(ctx.db, binding); execute.mockImplementation(call => authority.execute(call)); return createOpenCodeSemanticHandler(ctx.db, binding, { execute, completionFeedback: async () => "accepted", completionContract: { revision: 1, criterionIds: [] } }); },
    } });
    try {
      const observation = { sessionId: "ses_fixture", generation: host.generation };
      const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), taskSessionId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
      const controller = await currentNativeControllerIdentity();
      const binding = { companyId, projectId, issueId, agentId, runId, taskSessionId, normalizedSessionId, runnerInstanceId, providerSessionId: observation.sessionId, generation: observation.generation, epoch: randomUUID(), version: "2.2.5" as const, model: "fixture/model", effort: "high", leaseOwner: "fixture-lease", leaseAttempt: 1, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 };
      await ctx.db.insert(companies).values({ id: companyId, name: "Managed", issuePrefix: "OCM" });
      await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "paperclip_runner" });
      await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Project" });
      await ctx.db.insert(issues).values({ id: issueId, companyId, projectId, title: "Issue", assigneeAgentId: agentId, status: "in_progress" });
      await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, status: "running", runtimeMode: "native" });
      await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await ctx.db.insert(agentTaskSessions).values({ id: taskSessionId, companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId, sessionParamsJson: {} });
      await ctx.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "running", leaseOwner: binding.leaseOwner, attempt: 1, leaseExpiresAt: new Date(Date.now() + 60_000), controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 });
      const admissionExecution = buildNativeExecutionInput({ companyId, runId, agentId, issue: { id: issueId, identifier: "OCM-1", title: "Issue", description: null, workMode: "standard" }, taskPrompt: "Issue", workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId, provider: "opencode_shared_v2", model: binding.model, opencodeEffort: binding.effort, completionContract: { id: "fixture", sha256: "sha256:" + "a".repeat(64), schemaVersion: "v1", contract: { revision: "fixture", objective: "Issue", criteria: [{ id: "c", requirement: "Done" }] } }, runtimeContext: nativeRuntimeContextFixture() });
      await host.verifyCatalog(binding.model, binding.effort);
      await expect(host.verifyCatalog(binding.model, "missing")).rejects.toThrow("variant_unavailable");
      await expect(host.verifyCatalog("foreign/model", binding.effort)).rejects.toThrow("identity_invalid");
      const claim = { execution: admissionExecution, runnerInstanceId, leaseOwner: binding.leaseOwner, attempt: 1, controller };
      await expect(claimOpenCodeTaskSession(ctx.db, { ...claim, leaseOwner: "foreign" })).rejects.toThrow("lease_lost");
      expect(await claimOpenCodeTaskSession(ctx.db, claim)).toEqual({ taskSessionId, projectId, controllerGeneration: 1 });
      await expect(host.persistForRun(ctx.db, { ...binding, model: "other/model" })).rejects.toThrow("model_mismatch");
      await expect(host.persistForRun(ctx.db, { ...binding, effort: "low" })).rejects.toThrow("model_mismatch");
      await host.createManagedSession(ctx.db, binding);
      await proxy.close();
      const successor = { ...binding, leaseOwner: "successor-controller", leaseAttempt: 2, controllerGeneration: 2 };
      await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: successor.leaseOwner, attempt: successor.leaseAttempt, controllerGeneration: successor.controllerGeneration }).where(eq(nativeRunFinalizations.runId, runId));
      const successorInput = { execution: admissionExecution, runnerInstanceId, leaseOwner: successor.leaseOwner, attempt: successor.leaseAttempt, controller };
      expect(await loadOpenCodeSuccessorBinding(ctx.db, successorInput)).toMatchObject(successor);
      await expect(loadOpenCodeSuccessorBinding(ctx.db, { ...successorInput, leaseOwner: "stale" })).rejects.toThrow("lease_lost");
      await expect(restoreOpenCodeProviderListener(ctx.db, binding, {})).rejects.toThrow("lease_lost");
      const foreign = createServer();
      await new Promise<void>((resolve, reject) => { foreign.once("error", reject); foreign.listen(Number(new URL(proxy.baseURL).port), "127.0.0.1", resolve); });
      try { await expect(restoreOpenCodeProviderListener(ctx.db, successor, {})).rejects.toMatchObject({ code: "EADDRINUSE" }); }
      finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
      const restoredProxy = await restoreOpenCodeProviderListener(ctx.db, successor, {});
      try {
        const held = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "model" }) });
        expect(held.status).toBe(503);
      } finally { await restoredProxy.close(); }
      const restoredListeners = await restoreOpenCodeManagedObservation({ db: ctx.db, ...successorInput, environment: {}, tools: [{ name: "get_task_context", inputSchema: { type: "object" } }] });
      try {
        const held = await fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "model" }) });
        expect(held.status).toBe(503);
        await expect(restoreOpenCodeManagedObservation({ db: ctx.db, ...successorInput, environment: {}, tools: [] })).rejects.toMatchObject({ code: "EADDRINUSE" });
      } finally { await restoredListeners.close(); }
      await expect(restoreOpenCodeManagedObservation({ db: ctx.db, ...successorInput, environment: {}, tools: [] })).rejects.toThrow("restoration_outcome_unknown");
      await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: binding.leaseOwner, attempt: binding.leaseAttempt, controllerGeneration: binding.controllerGeneration }).where(eq(nativeRunFinalizations.runId, runId));
      retainOpenCodeManagedHost(binding, host);
      const reconnected = await reconnectOpenCodeManagedHost(ctx.db, binding);
      expect(reconnected.host).toBe(host);
      expect(reconnected.binding.providerSessionId).toBe(binding.providerSessionId);
      await expect(reconnectOpenCodeManagedHost(ctx.db, { ...binding, epoch: randomUUID() })).rejects.toThrow("binding_mismatch");
      expect(await host.dispatchForRun(ctx.db, binding, { id: "msg_fixture", text: "test only" })).toEqual({ delivery: "acknowledged", taskCompletion: "unproven" });
      await expect(host.dispatchForRun(ctx.db, binding, { id: "msg_fixture", text: "test only" })).rejects.toThrow("already_recorded");
      await expect(resumeOpenCodeManagedOperation({ db: ctx.db, binding, prompt: { id: "msg_fixture", text: "test only" } })).rejects.toThrow("already_recorded");
      expect(await resumeOpenCodeManagedOperation({ db: ctx.db, binding, prompt: { id: "msg_resume", text: "second test" } })).toEqual({ delivery: "acknowledged", taskCompletion: "unproven" });
      const ingress = await host.startScopedIngress(ctx.db, binding);
      const reader = { authorization: `Bearer ${ingress.readerToken}` }, owner = { authorization: `Bearer ${ingress.ownerToken}`, "content-type": "application/json" };
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture`, { headers: reader })).status).toBe(200);
      expect((await fetch(`${ingress.origin}/api/session/ses_foreign`, { headers: owner })).status).toBe(403);
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture/model`, { method: "POST", headers: owner, body: "{}" })).status).toBe(403);
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture/prompt`, { method: "POST", headers: reader, body: "{}" })).status).toBe(403);
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture/prompt`, { method: "POST", headers: owner, body: JSON.stringify({ id: "msg_owner", text: "owner steer", delivery: "steer" }) })).status).toBe(403);
      const [session] = await ctx.db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, taskSessionId));
      expect(session!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { providerSessionId: observation.sessionId, mutations: [{ id: "msg_fixture", state: "acknowledged" }, { id: "msg_resume", state: "acknowledged" }] } });
      expect(session!.sessionParamsJson).toMatchObject({ opencodeSharedV2: { semanticCalls: [{ state: "returned" }, { state: "returned" }] } });
      expect(execute).toHaveBeenCalledTimes(2);
      await expect(transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "msg_fixture", tool: "get_task_context", arguments: {} })).rejects.toThrow("outcome_unknown_or_recorded");
      await expect(transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "msg_fixture", tool: "get_task_context", arguments: { id: "different" } })).rejects.toThrow("identity_conflict");
      await transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "recoverable", tool: "read", arguments: { key: 1 } });
      const recover = vi.fn<() => Promise<{ result: unknown } | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce({ result: { receipt: "fixture" } });
      const reconcile = createOpenCodeSemanticHandler(ctx.db, binding, { execute, recover, completionFeedback: async () => "unused", completionContract: { revision: "fixture", criterionIds: [] } });
      await expect(reconcile({ callId: "recoverable", tool: "read", arguments: { key: 2 }, signal: new AbortController().signal })).rejects.toThrow("identity_conflict");
      await expect(reconcile({ callId: "recoverable", tool: "read", arguments: { key: 1 }, signal: new AbortController().signal })).rejects.toThrow("outcome_unknown");
      await expect(transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "too-early", tool: "paperclip_finish", arguments: {} })).rejects.toThrow("outcome_unknown");
      expect(await reconcile({ callId: "recoverable", tool: "read", arguments: { key: 1 }, signal: new AbortController().signal })).toEqual({ receipt: "fixture" });
      expect(recover).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(2);
      const feedback = vi.fn((result: Parameters<typeof nativeCompletionFeedback>[2]) => nativeCompletionFeedback(ctx.db, runId, result));
      const semantic = createOpenCodeSemanticHandler(ctx.db, binding, { execute, completionFeedback: feedback, completionContract: { revision: "fixture", criterionIds: ["c"] } });
      const report = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Fixture", completionClaim: { contractRevision: "fixture", objectiveSatisfied: true, criteria: [{ criterionId: "c", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] };
      await expect(semantic({ callId: "invalid", tool: "paperclip_finish", arguments: { ...report, completionClaim: { ...report.completionClaim, contractRevision: "foreign" } }, signal: new AbortController().signal })).rejects.toThrow("contract_mismatch");
      // The terminal may reserve after startTurn's initial read but before its
      // mutation reservation. The lease-locked dispatch must still refuse it.
      await transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "racing-finish", tool: "paperclip_finish", arguments: report });
      await expect(host.dispatchForRun(ctx.db, binding, { id: "msg_racing", text: "must not send" })).rejects.toThrow("terminal_already_recorded");
      await transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "racing-finish", tool: "paperclip_finish", arguments: report, outcome: { result: { error: "rejected" }, isError: true } });
      const admitted = createOpenCodeNativePort(ctx.db, binding, host);
      const execution = admissionExecution;
      const prpEvents: string[] = [];
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const completedPromise = executeNativeSession({ input: execution, backend: new OpenCodeSharedNativeBackend({ ...admitted.port, async startObservation() { await admitted.port.startObservation(); ready(); } }), authorizeWorkSessionResult: admitted.authorizeWorkSessionResult,
        runnerInstanceId, controlPlaneInstanceId: "fixture-control", timeoutMs: 5000, controlPlane: {
          async openRun() {}, async checkpointSession() {}, async completeRun() {}, async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
          async appendEvent(event) { const seq = "sourceSeq" in event ? event.sourceSeq : event.sequence; if ("eventType" in event) { expect(validatePrpEvent(event)).toMatchObject({ ok: true }); prpEvents.push(event.eventType); } return { cursor: seq, highestContiguousSourceSeq: seq, disposition: "committed" }; },
        },
      });
      await Promise.race([started, completedPromise.then(() => { throw new Error("unexpected early completion"); })]);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(await semantic({ callId: "finish", tool: "paperclip_finish", arguments: report, signal: new AbortController().signal })).toMatchObject({ feedback: expect.any(String), result: report });
      const completed = await completedPromise;
      await expect(host.dispatchForRun(ctx.db, binding, { id: "msg_after_finish", text: "must not send" })).rejects.toThrow("terminal_already_recorded");
      expect(await readOpenCodeTerminalReceipt(ctx.db, binding)).toMatchObject({ result: report, operationId: expect.any(String), recordedAt: expect.any(String) });
      expect(completed.result).toEqual(report);
      expect(prpEvents).toContain("run.result.proposed");
      expect(prpEvents).not.toContain("turn.completed");
      const observed = await ctx.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      expect(observed.some(event => event.eventType === "opencode.shared.log" && JSON.stringify(event.payload).includes("evt_fixture"))).toBe(true);
      expect(observed.some(event => event.eventType === "tool.execution.started" && JSON.stringify(event.payload).includes('"origin":"unknown"'))).toBe(true);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(feedback).toHaveBeenCalledTimes(1);
      await expect(semantic({ callId: "other-finish", tool: "paperclip_finish", arguments: report, signal: new AbortController().signal })).rejects.toThrow("terminal_already_recorded");
      await expect(transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "after-finish", tool: "read", arguments: {} })).rejects.toThrow("terminal_already_recorded");
      await ctx.db.update(nativeRunFinalizations).set({ leaseOwner: "successor" }).where(eq(nativeRunFinalizations.runId, runId));
      await expect(reconnectOpenCodeManagedHost(ctx.db, binding)).rejects.toThrow("lease_lost");
      await expect(readOpenCodeTerminalReceipt(ctx.db, binding)).rejects.toThrow("lease_lost");
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture`, { headers: reader })).status).toBe(503);
      expect((await fetch(`${ingress.origin}/api/session/ses_fixture/prompt`, { method: "POST", headers: owner, body: JSON.stringify({ id: "msg_stale", text: "stale" }) })).status).toBe(403);
      await expect(transitionOpenCodeSemanticCall(ctx.db, binding, { callId: "stale", tool: "read", arguments: {} })).rejects.toThrow("lease_lost");
      expect(JSON.stringify(session!.sessionParamsJson)).not.toContain("test only");
      await host.shutdown();
      forgetOpenCodeManagedHost(binding, host);
      await expect(reconnectOpenCodeManagedHost(ctx.db, binding)).rejects.toThrow("binding_mismatch");
    } finally { await host.shutdown(); vi.unstubAllEnvs(); }
  }, 30_000);
});
