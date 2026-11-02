import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane, spawnRunner, type RunnerProcessHandle } from "../../control-plane/durable-prp-control-plane.js";
import { readRunnerdArtifactBinding } from "../../live/runnerd-codex-transport.js";
import { launchRunnerdAntigravity, type RunnerdAntigravityPort } from "./runnerd-antigravity-port.js";
import type { AntigravityHeadlessController } from "./headless-controller.js";

it("drives an authenticated Runner through one fake native turn and proven close", async () => {
  const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-prp-");
  const fake = join(root, "fake-agy");
  await writeFile(fake, `#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');\nlet s='';process.stdin.on('data',d=>{s+=d;if(s.includes('\\n')){process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:'native',status:'SUCCESS',response:'fake'}})+'\\n');s='';}});`, { mode: 0o700 });
  const journal = join(root,"journal"), runnerDir = join(root,"runner"); await mkdir(journal,{mode:0o700}); await mkdir(runnerDir,{mode:0o700});
  const identity={runnerInstanceId:"runner",environmentLeaseId:"lease",runId:"run",normalizedSessionId:"session",turnId:"turn",itemId:"item"};
  const binding={bindingId:"binding",bindingGeneration:1,runId:"run",environmentLeaseId:"lease",normalizedSessionId:"session",turnId:"turn"};
  const binary=process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ?? resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd");
  const artifact=readRunnerdArtifactBinding(binary);
  let port:RunnerdAntigravityPort|undefined, controller:AntigravityHeadlessController|undefined, runner:RunnerProcessHandle|undefined;
  let initialized!:()=>void; const ready=new Promise<void>(r=>{initialized=r;});
  const events:string[]=[];
  const core=new DurablePrpControlPlane({stateDirectory:join(root,"control"),identity,expectedRunnerVersion:artifact.version,expectedRunnerDigest:artifact.digest,
    onCommittedEvent:async event=>{events.push(event.eventType);if(event.eventType==="native_controller.dispatch_requested") port!.dispatch(event);}});
  try {
    await core.start();
    const launched=launchRunnerdAntigravity({core,executable:fake,verifiedVersion:"1.4.12",cwd:root,env:{PATH:process.env.PATH},journalDirectory:journal,conversationId:"native",...binding,admit:()=>true,onUncertain:()=>{},onEvent:event=>{if(event.kind==="init")initialized();}});
    port=launched.port; controller=launched.controller; await ready;
    const ticket=core.issueBootstrapTicket(60_000); await core.flushCheckpoint();
    runner=spawnRunner({connectUrl:core.connectUrl,stateDirectory:runnerDir,identity,ticket,runnerBinaryPath:binary,runnerVersion:artifact.version,runnerDigest:artifact.digest,maxOutboxBytes:1024*1024,p0ReserveBytes:64*1024,maxRuntimeMs:0,environment:{PATH:process.env.PATH}});
    const wait=async(id:string)=>{await vi.waitFor(()=>{const c=core.getCommand(id);expect(c?.status).toBe("completed");},{timeout:15000,interval:25});return core.getCommand(id)!;};
    core.queueCommand("run.prepare",{provider:{kind:"antigravity_headless",conversationId:"native",processGeneration:controller.generation,bindingId:"binding",bindingGeneration:1,startCommandId:"start",controllerCapability:"antigravity-headless-dispatch.v1",observationCapability:"antigravity-tool-observation.v1"}},"prepare",true);await wait("prepare");
    core.queueCommand("session.open",{},"open",true);await wait("open");
    core.queueCommand("turn.start",{text:"hello"},"start",true);await wait("start");
    try { await vi.waitFor(()=>expect(events).toContain("harness.diagnostic"),{timeout:15000,interval:25}); }
    catch (error) { const state=JSON.parse(await readFile(join(runnerDir,"runner-state.json"),"utf8")); throw new Error(JSON.stringify({ events, commands:core.store.state.commands.map(c=>({type:c.type,status:c.status,result:c.result})), committed:core.store.state.committedEvents.length, outbox:state.outbox, diagnostics:state.diagnostics }),{cause:error}); }
    expect(events).not.toContain("run.terminal");
    core.queueCommand("turn.interrupt",{},"interrupt",true);
    await vi.waitFor(()=>expect(core.getCommand("interrupt")?.status).toBe("failed"),{timeout:15000,interval:25});
    await port.closeOwned();
    await vi.waitFor(()=>expect(core.store.state.commands.some(c=>c.type==="native_controller.observation"&&c.status==="completed"&&(c.payload as Record<string,unknown>).action==="antigravity.provider_exit")).toBe(true),{timeout:15000,interval:25});
    core.queueCommand("runner.shutdown",{},"shutdown",true);await wait("shutdown");
    expect((await runner.completion).code).toBe(0); runner=undefined;
  } finally {
    if(controller)await controller.closeOwned().catch(()=>{});
    if(runner){runner.child.kill("SIGTERM");await runner.completion.catch(()=>{});}
    await core.stop();await rm(root,{recursive:true,force:true});
  }
}, 60000);
