import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import requestHttp from "supertest";
import { heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { nativeToolContractFingerprintForTarget } from "./native-session-resume.js";
import { nativeSha256 } from "./canonical.js";

const fixture = vi.hoisted(() => ({ enabled: false, owner: {} as Record<string, unknown> }));
vi.mock("./cancelled-retained-cleanup-authority.js", async (original) => {
  const actual = await original<typeof import("./cancelled-retained-cleanup-authority.js")>();
  Object.assign(fixture.owner, actual.exactCancelledOwner);
  const bound = () => actual.createCancelledCleanupAuthorityForTest(fixture.owner as unknown as typeof actual.exactCancelledOwner);
  return { ...actual, exactCancelledOwner: fixture.owner,
    assessCancelledNativeOwner: (...args: Parameters<typeof actual.assessCancelledNativeOwner>) => fixture.enabled ? bound().assessCancelledNativeOwner(...args) : actual.assessCancelledNativeOwner(...args),
    exactOwnerIdentityMatches: (...args: Parameters<typeof actual.exactOwnerIdentityMatches>) => fixture.enabled ? bound().exactOwnerIdentityMatches(...args) : actual.exactOwnerIdentityMatches(...args),
    exactCancelledCleanupJournalMatches: (...args: Parameters<typeof actual.exactCancelledCleanupJournalMatches>) => fixture.enabled ? bound().exactCancelledCleanupJournalMatches(...args) : actual.exactCancelledCleanupJournalMatches(...args),
    prepareExactCancelledRecoveryIntent: (...args: Parameters<typeof actual.prepareExactCancelledRecoveryIntent>) => fixture.enabled ? bound().prepareExactCancelledRecoveryIntent(...args) : actual.prepareExactCancelledRecoveryIntent(...args),
    reservePreparedCancelledIntent: (...args: Parameters<typeof actual.reservePreparedCancelledIntent>) => fixture.enabled ? bound().reservePreparedCancelledIntent(...args) : actual.reservePreparedCancelledIntent(...args),
    consumePreparedCancelledIntent: (...args: Parameters<typeof actual.consumePreparedCancelledIntent>) => fixture.enabled ? bound().consumePreparedCancelledIntent(...args) : actual.consumePreparedCancelledIntent(...args),
  };
});
import { exactCancelledOwner as owner } from "./cancelled-retained-cleanup-authority.js";
import { cancelledNativeCleanupRoutes } from "../../routes/cancelled-native-cleanup.js";
import { errorHandler } from "../../middleware/error-handler.js";

const request = { companyId: owner.companyId, runId: owner.runId,
  expectedFingerprint: owner.sourceFingerprint, actorId: "board-user",
  requestId: "a1e52d6f-4d43-4db8-a7af-99f010001111" };

import { randomUUID } from 'node:crypto';
import { agents, companies, issues, completionContracts, workAssessments, statusDecisions, createDb, startEmbeddedPostgresTestDatabase } from '@paperclipai/db';
import { createLocalEncryptedCipher } from '../../secrets/local-encrypted-provider.js';
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from '../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.js';

it.each(['settled','foreign_receipt','unknown_tool','bad_generation', ...(process.env.PAPERCLIP_TEST_OLD_RECOVERY_RUNNER_BINARY ? ['missing_exit'] : [])])('real Board, Postgres and Runner: %s', async (mode) => {
    const container = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/cancelled-recovery-integration-");
    const base = join(container, "durable-sessions"); mkdirSync(base, { mode: 0o700 });
    const oldOwner = { ...fixture.owner };
    Object.assign(fixture.owner, { companyId:randomUUID(),agentId:randomUUID(),issueId:randomUUID(),runId:randomUUID(),nativeSessionId:randomUUID(),runnerInstanceId:randomUUID(),environmentLeaseId:randomUUID(),providerSessionId:randomUUID(),runnerPid:99999990,providerPid:99999991 });
    const contractId=randomUUID();
    const previous = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    const previousPath=process.env.PATH, previousKey=process.env.PAPERCLIP_SECRETS_MASTER_KEY, previousTmp=process.env.TMPDIR, previousRunner=process.env.PAPERCLIP_TEST_RECOVERY_RUNNER_BINARY;
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
    let db: ReturnType<typeof createDb> | undefined;
    let bundle: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY='a'.repeat(64);
    process.env.TMPDIR=container;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = base;
    fixture.enabled = true;
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const canonical = (value: unknown): string => value && typeof value === "object" && !Array.isArray(value)
      ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
      : JSON.stringify(value);
    const runnerBinary=mode==='missing_exit' ? process.env.PAPERCLIP_TEST_OLD_RECOVERY_RUNNER_BINARY! : (process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? defaultCapabilityRunnerdBinary());
    process.env.PAPERCLIP_TEST_RECOVERY_RUNNER_BINARY=runnerBinary;
    const fakeBinary=process.env.PAPERCLIP_FAKE_CODEX_BINARY ?? resolve(import.meta.dirname,'../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server');
    if(!existsSync(runnerBinary)||!existsSync(fakeBinary)) throw Error('Build the Runner and fake Codex test binaries first');
    const bin=join(container,'bin'); mkdirSync(bin,{mode:0o700});symlinkSync(fakeBinary,join(bin,'codex'));process.env.PATH=`${bin}:/usr/bin:/bin`;
    const execution = { schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
      binding: { companyId: owner.companyId, runId: owner.runId, issueId: owner.issueId, agentId: owner.agentId, executionWorkspaceId: "workspace" },
      task: { identifier: "TEST", title: "Test", description: null, prompt: "Test", workMode: "standard" },
      workspace: { cwd: container, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: owner.nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contractId, sha256: "sha", schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Test", criteria: [{ id: "objective", requirement: "Test" }] } }, interactionResponses: [], credentialBindings: [] };
    const key = sha(canonical({ schema: "paperclip.native-session-scope.v2", companyId: owner.companyId, agentId: owner.agentId,
      workspace: { kind: "managed", executionWorkspaceId: "workspace" }, provider: { driverKind: "codex_app_server", identity: { kind: "codex" } }, normalizedSessionId: owner.nativeSessionId }));
    const root = join(base, key);
    const identity = { runnerInstanceId: owner.runnerInstanceId, environmentLeaseId: owner.environmentLeaseId,
      runId: owner.runId, normalizedSessionId: owner.nativeSessionId, turnId: "turn", itemId: "item" };
    const fakeHome=join(container,'fake-home'); mkdirSync(fakeHome,{mode:0o700});
    bundle=createCapabilityRunnerdCodexTransport({runnerBinary,
      codexCommand:fakeBinary,
      codexArgs:['--state-file',join(container,'fake.json'),'--call-log',join(container,'fake-calls.log'),'--hold-turn'],
      sourceCodexHome:fakeHome,stateDirectory:root,prpIdentity:identity});
    const thread=await bundle.transport.request('thread/start',{cwd:container,dynamicTools:[]}) as any;
    await bundle.transport.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'fixture'}]});
    const runnerPid=bundle.evidence().runnerPid!, providerPid=bundle.evidence().providerPid!;
    Object.assign(fixture.owner,{runnerPid,providerPid,providerSessionId:thread.thread.id});
    await bundle.detachControllerForRestart();
    for(const pid of [runnerPid,providerPid]) { try { process.kill(-pid,'SIGKILL'); } catch(e:any) { if(e.code!=='ESRCH') throw e; } }
    await vi.waitFor(()=>{for(const pid of [runnerPid,providerPid]){try{process.kill(pid,0);throw Error('fixture process still alive');}catch(e:any){if(e.code!=='ESRCH')throw e;}}});
    bundle=undefined;
    const realControl=JSON.parse(readFileSync(join(root,'control-plane/control-plane-state.json'),'utf8'));
    const realRunner=JSON.parse(readFileSync(join(root,'runner/runner-state.json'),'utf8'));
    const realProvider=JSON.parse(readFileSync(join(root,'runner/codex-provider-state.json'),'utf8'));
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
      { type: "turn.start", status: "completed", result: { result: { providerTurnId: "provider-turn" } } }, ...Array.from({length:498},()=>({type:"runner.drain",status:"completed"}))];
    const pending = Object.fromEntries([["read1", "GET /one"], ["read2", "GET /two"], ["write", "PUT /three"]].map(([callId, operationId]) => [callId, { callId, operationId: "call_api", input: { operationId } }]));
    if(mode==='unknown_tool') pending.read1.operationId='unknown_tool';
    const tool={operationId:'call_api',version:1,description:'Synthetic API',inputSchema:{type:'object'},responseSchema:{type:'object'}};
    const receipts = { [sha("write")]: { state: "completed", operationId: "PUT /three", digest: sha(canonical({ operationId: "PUT /three" })), encryptedResult: createLocalEncryptedCipher('write').encrypt(JSON.stringify({ok:true,operationId:'PUT /three'})) } };
    if(mode==='foreign_receipt') receipts[sha('write')]!.digest='0'.repeat(64);
    const source = [
      ["control-plane/control-plane-state.json", { ...realControl, identity, ackedSourceSeq:realRunner.nextSourceSeq-1, commands:commands.map((c,i)=>({schema:"paperclip.prp.command.v1",commandId:"command-"+i,controllerSeq:i+1,issuedAt:new Date().toISOString(),payload:{},result:null,...c})), committedEvents:[event,...semanticEvents].map(payload=>({sourceSeq:payload.sourceSeq,sourceEventId:payload.sourceEventId,eventType:payload.eventType,priority:payload.priority,envelope:{payload},deliveryCount:1,logicalEffectCount:1})) }],
      ["runner/runner-state.json", { ...realRunner, ...identity, outbox: [], ackedSourceSeq:realRunner.nextSourceSeq-1, lastControllerCommandSeq:500, compactedThroughControllerSeq:500, processedCommands:{}, processedCommandFingerprints:{}, lifecycle: "recoverable_failure" }],
      ["runner/codex-provider-state.json", { ...realProvider, ...(mode==='bad_generation'?{providerProcessGeneration:-1}:{}), lifecycle: "session_open", activeProviderTurnId:null, threadId: owner.providerSessionId, config: { ...realProvider.config, provider: "codex", command: "codex", cwd: container }, toolBridge: { ...realProvider.toolBridge, authorized:{call_api:tool},catalogOperations:[tool],catalogDigest:`sha256:${nativeSha256([tool])}`,pending, turnClosed: true }, pendingEvents: [], queuedEvents: [] }],
    ] as const;
    mkdirSync(join(root, "runner"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "control-plane"), { recursive:true, mode: 0o700 });
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
      processGroupId: null, processStartedAt: null, finishedAt: new Date(), lastOutputSeq:1, nextEventSeq:2, completionContractId: contractId, completionContractSha256: "sha",
      resultJson: { apiToolReceipts: receipts }, runnerProfileJson: { nativeExecutionInput: execution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local") } };

    writeFileSync(join(container,'fake.json'), JSON.stringify({threadId:owner.providerSessionId,activeTurnId:null,nextTurn:1}), {mode:0o600});
    writeFileSync(join(container,'fake-calls.log'),'',{mode:0o600});
    database = await startEmbeddedPostgresTestDatabase('combined-recovery-');
    db = createDb(database.connectionString);
    const resultId=randomUUID(), assessmentId=randomUUID(), decisionId=randomUUID();
      await db.insert(companies).values({id:owner.companyId,name:'Fixture',issuePrefix:'FX'});
      await db.insert(agents).values({id:owner.agentId,companyId:owner.companyId,name:'Fixture agent',adapterType:'paperclip_runner'});
      await db.insert(issues).values({id:owner.issueId,companyId:owner.companyId,title:'Fixture task',assigneeAgentId:owner.agentId});
      await db.insert(completionContracts).values({id:contractId,companyId:owner.companyId,issueId:owner.issueId,revision:1,schemaVersion:'paperclip.completion-contract.v1',policyVersion:'1',risk:'low',completionAuthority:'system',incompleteCriteriaPolicy:'review',contractJson:execution.completionContract.contract,canonicalSha256:'sha',createdByActorType:'user',createdByActorId:'fixture'});
      await db.insert(heartbeatRuns).values(run);
      await db.insert(nativeRunResults).values({id:resultId,companyId:owner.companyId,issueId:owner.issueId,runId:owner.runId,completionContractId:contractId,...accepted});
      await db.insert(workAssessments).values({id:assessmentId,companyId:owner.companyId,issueId:owner.issueId,runId:owner.runId,contractId,resultId,triggerKind:'fixture',triggerActorCompanyId:owner.companyId,priorIssueStatus:'in_progress',priorStatusVersion:1,policyVersion:'1',assessmentJson:{},inputDigest:'fixture'});
      await db.insert(statusDecisions).values({id:decisionId,companyId:owner.companyId,issueId:owner.issueId,runId:owner.runId,assessmentId,decisionVersion:1,policyVersion:'1',fromStatus:'in_progress',toStatus:'in_progress',reasonCode:'fixture',decisionJson:{},decisionDigest:'fixture'});
      await db.insert(nativeRunFinalizations).values({companyId:owner.companyId,issueId:owner.issueId,runId:owner.runId,phase:'committed',resultId,assessmentId,decisionId});
      await db.insert(heartbeatRunEvents).values({...persistedIdentity,companyId:owner.companyId,agentId:owner.agentId,runId:owner.runId,seq:1});
      const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor={type:'board',source:'board_key',isInstanceAdmin:true,userId:'fixture-board',companyIds:[owner.companyId]};next();});app.use('/api',cancelledNativeCleanupRoutes(db));app.use(errorHandler);
      const response=await requestHttp(app).post(`/api/companies/${owner.companyId}/native-cleanup/cancelled`).send({runId:owner.runId,expectedFingerprint:fingerprint,requestId:request.requestId});
      const rows=await db.select().from(nativeRunFinalizations);
      const calls=readFileSync(join(container,'fake-calls.log'),'utf8').trim().split('\n');
      expect(calls).not.toContain('turn/start');
      expect(response.status).toBe(200);
      if(mode==='settled') {
        expect(response.body.status).toBe('settled');
        expect(rows[0]!.recoveryHistory.some((x:any)=>x.kind==='native_cleanup_maintenance'&&x.phase==='settled')).toBe(true);
        const archive=rows[0]!.recoveryHistory.find((x:any)=>x.kind==='native_cleanup_source_archive'&&x.phase==='archived') as any;
        expect(archive).toBeDefined();
        expect(source.map(([file])=>readFileSync(join(base,'quarantine',archive.archiveName,file)))).toEqual(originals);
        const control=JSON.parse(readFileSync(join(root,'control-plane/control-plane-state.json'),'utf8'));
        const oldControl=JSON.parse(originals[0]!.toString());
        expect(control.commands.slice(0,500)).toEqual(oldControl.commands);
        expect(control.commands.find((c:any)=>c.type==='session.close'&&c.controllerSeq>500)).toMatchObject({status:'completed',result:{result:{providerExitConfirmed:true}}});
        expect(control.commands.filter((c:any)=>c.type==='semantic_tool.result'&&c.controllerSeq>500).map((c:any)=>c.status)).toEqual(['completed','completed','completed']);
        const settledProvider=JSON.parse(readFileSync(join(root,'runner/codex-provider-state.json'),'utf8'));
        expect(settledProvider.lifecycle).toBe('closed'); expect(settledProvider.toolBridge.pending).toEqual({});
        expect(JSON.parse(readFileSync(join(root,'runner/runner-state.json'),'utf8')).lifecycle).toBe('suspended');
        const actualRun=(await db.select().from(heartbeatRuns))[0]!; expect(actualRun.status).toBe('cancelled');
      } else if(mode==='foreign_receipt'||mode==='unknown_tool') {
        expect(response.body.status).toBe('not_eligible');
        expect(source.map(([file])=>readFileSync(join(root,file)))).toEqual(originals);
      } else {
        expect(response.body.status).toBe('operator_required');
        expect(rows[0]!.recoveryHistory.some((x:any)=>x.kind==='native_cleanup_maintenance'&&x.phase==='settled')).toBe(false);
        if(mode==='missing_exit') {
          const staged=rows[0]!.recoveryHistory.find((x:any)=>x.kind==='native_cleanup_maintenance'&&x.phase==='staged') as any;
          const journal=JSON.parse(readFileSync(join(base,staged.stagingName,'control-plane/control-plane-state.json'),'utf8'));
          const close=journal.commands.find((x:any)=>x.type==='session.close'&&x.controllerSeq>500);
          expect(close.status).toBe('completed'); expect(close.result.result.providerExitConfirmed).toBeUndefined();
        }
      }
    } finally {
      if (bundle) {
        const evidence=bundle.evidence();
        await bundle.detachControllerForRestart().catch(()=>{});
        for(const pid of [evidence.runnerPid,evidence.providerPid]) if(pid) {
          try { process.kill(-pid,'SIGKILL'); } catch(e:any) { if(e.code!=='ESRCH') throw e; }
        }
      }
      await db?.$client.end(); await database?.cleanup(); fixture.enabled=false; Object.assign(fixture.owner,oldOwner);
      if(previous===undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR=previous;
      if(previousPath===undefined) delete process.env.PATH; else process.env.PATH=previousPath;
      if(previousKey===undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY=previousKey;
      if(previousTmp===undefined) delete process.env.TMPDIR; else process.env.TMPDIR=previousTmp;
      if(previousRunner===undefined) delete process.env.PAPERCLIP_TEST_RECOVERY_RUNNER_BINARY; else process.env.PAPERCLIP_TEST_RECOVERY_RUNNER_BINARY=previousRunner;
      rmSync(container,{recursive:true,force:true});
    }
},120_000);
