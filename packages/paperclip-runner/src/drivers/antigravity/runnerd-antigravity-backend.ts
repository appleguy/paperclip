import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NativeRunIdentity, NativeSessionCapabilities } from "../../contracts/types.js";
import type { NativeSession, NativeSessionBackend, OpenNativeSessionInput } from "../../contracts/native-session-backend.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { DurablePrpControlPlane, spawnRunner, type RunnerProcessHandle } from "../../control-plane/durable-prp-control-plane.js";
import { readRunnerdArtifactBinding } from "../../live/runnerd-codex-transport.js";
import { RunnerdAntigravityPort } from "./runnerd-antigravity-port.js";
import { AntigravityHeadlessController } from "./headless-controller.js";

const capabilities:NativeSessionCapabilities={resume:false,typedEvents:true,steering:false,interruption:false,structuredResult:false,dynamicTools:false,usage:false,providerTermination:"confirmed",unsupported:["automatic recovery","shared interactive remote control","approval responses","structured Paperclip completion","managed tool accounting","native tool ingress fencing"]};
export function describeAntigravityHeadlessBackend() { return {kind:"runner" as const,name:"antigravity_headless",version:"1.4.12",capabilities}; }
/** Explicitly admitted, single native conversation and one Runner turn. */
export class RunnerdAntigravityBackend implements NativeSessionBackend {
  constructor(private readonly options:{identity:NativeRunIdentity;runnerInstanceId:string;environmentLeaseId:string;turnId:string;itemId:string;bindingId:string;bindingGeneration:number;conversationId?:string;cwd:string;stateDirectory:string;runnerBinary:string;executable:string;verifiedVersion:string;env:NodeJS.ProcessEnv;admit:(sourceEventId:string)=>boolean | Promise<boolean>;withAdmission?:(sourceEventId:string,dispatch:()=>void)=>Promise<void>}) {}
  async descriptor(){return describeAntigravityHeadlessBackend();}
  async openSession(input:OpenNativeSessionInput):Promise<NativeSession>{
    const o=this.options;
    if(input.workingDirectory!==o.cwd || Object.keys(o.identity).some(key=>input.identity[key as keyof NativeRunIdentity]!==o.identity[key as keyof NativeRunIdentity]))throw new Error("Antigravity native authority mismatch");
    input.signal?.throwIfAborted();
    const runnerDir=join(o.stateDirectory,"runner"),journal=join(o.stateDirectory,"native-journal");
    // This implementation does not adopt old authority or recover a child.
    // An existing directory therefore fails before starting any process.
    mkdirSync(o.stateDirectory,{mode:0o700});mkdirSync(runnerDir,{mode:0o700});mkdirSync(journal,{mode:0o700});
    const artifact=readRunnerdArtifactBinding(o.runnerBinary);
    const identity={runnerInstanceId:o.runnerInstanceId,environmentLeaseId:o.environmentLeaseId,runId:o.identity.runId,normalizedSessionId:o.identity.sessionId,turnId:o.turnId,itemId:o.itemId};
    let port:RunnerdAntigravityPort|undefined,controller:AntigravityHeadlessController|undefined,runner:RunnerProcessHandle|undefined;
    const events:PrpEvent[]=[];const waiters=new Set<()=>void>();let closed=false;let failure:unknown;let admittedEvent:string | undefined;
    const wake=()=>{for(const waiter of waiters)waiter();waiters.clear();};
    const core=new DurablePrpControlPlane({stateDirectory:join(o.stateDirectory,"control-plane"),identity,expectedRunnerVersion:artifact.version,expectedRunnerDigest:artifact.digest,
      onCommittedEvent:async event=>{if(events.length>=4096)throw new Error("Antigravity event buffer full");if(event.eventType==="native_controller.dispatch_requested"){const dispatch=()=>{admittedEvent=event.sourceEventId;try{port!.dispatch(event);}finally{admittedEvent=undefined;}};if(o.withAdmission)await o.withAdmission(event.sourceEventId,dispatch);else{if(!await o.admit(event.sourceEventId))throw new Error("Antigravity server lease admission denied");dispatch();}}events.push(event);wake();}});
    const waitCommand=async(id:string)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){input.signal?.throwIfAborted();const command=core.getCommand(id);if(command?.status==="completed")return command;if(command&&["failed","rejected","indeterminate"].includes(command.status))throw new Error(`Antigravity Runner command ${command.status}`);await new Promise(r=>setTimeout(r,25));}throw new Error("Antigravity Runner command outcome unknown");};
    try {
      await core.start();let initialized!:(conversationId:string)=>void;const ready=new Promise<string>(resolve=>{initialized=resolve;});
      controller=AntigravityHeadlessController.launch({executable:o.executable,verifiedVersion:o.verifiedVersion,cwd:o.cwd,env:o.env,conversationId:o.conversationId,authorize:id=>id===admittedEvent,onUncertain:()=>{failure=new Error("Antigravity prompt outcome unknown");wake();},onEvent:event=>{if(event.kind==="init")initialized(event.conversationId);else if(port)port.observe(event);else throw new Error("Antigravity event before binding");}});
      let timer:ReturnType<typeof setTimeout>|undefined;
      let conversationId:string;
      try{conversationId=await Promise.race([ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Antigravity initialization timeout")),5000);})]);}finally{if(timer)clearTimeout(timer);}
      port=new RunnerdAntigravityPort({controller,journalDirectory:journal,conversationId,processGeneration:controller.generation,bindingId:o.bindingId,bindingGeneration:o.bindingGeneration,runId:o.identity.runId,environmentLeaseId:o.environmentLeaseId,normalizedSessionId:o.identity.sessionId,turnId:o.turnId,admit:id=>id===admittedEvent,queueResult:(id,payload)=>{core.queueCommand("native_controller.observation",payload,id,true);}});
      input.signal?.throwIfAborted();
      const ticket=core.issueBootstrapTicket(60000);await core.flushCheckpoint();
      runner=spawnRunner({connectUrl:core.connectUrl,stateDirectory:runnerDir,identity,ticket,runnerBinaryPath:o.runnerBinary,runnerVersion:artifact.version,runnerDigest:artifact.digest,maxOutboxBytes:1024*1024,p0ReserveBytes:64*1024,maxRuntimeMs:0,environment:{PATH:process.env.PATH}});
      void runner.completion.then(()=>{if(!closed){failure=new Error("Antigravity Runner exited; outcome unknown");wake();}},()=>{if(!closed){failure=new Error("Antigravity Runner exit unknown");wake();}});
      const startCommandId="antigravity_start";
      core.queueCommand("run.prepare",{provider:{kind:"antigravity_headless",conversationId,processGeneration:controller.generation,bindingId:o.bindingId,bindingGeneration:o.bindingGeneration,startCommandId,controllerCapability:"antigravity-headless-dispatch.v1"}},"antigravity_prepare",true);
      const prepared=await waitCommand("antigravity_prepare");
      const acknowledgement=prepared.result?.result;
      if(!acknowledgement || typeof acknowledgement!=="object" || (acknowledgement as Record<string,unknown>).controllerCapability!=="antigravity-headless-dispatch.v1")throw new Error("Antigravity Runner capability not acknowledged");
      core.queueCommand("session.open",{},"antigravity_open",true);await waitCommand("antigravity_open");
      let started=false;
      return {
        identity:()=>({...o.identity}),capabilities:async()=>({...capabilities}),
        async *events(){let index=0;while(!closed){while(index<events.length)yield events[index++]!;if(failure)throw failure;await new Promise<void>(resolve=>waiters.add(resolve));}},
        async startTurn({message}){if(started)throw new Error("Antigravity turn already dispatched");started=true;core.queueCommand("turn.start",{text:message.text},startCommandId,true);await waitCommand(startCommandId);return {turnId:o.turnId};},
        async result(){return null;},
        async snapshot(){return {backendKind:"runner",driverKind:"antigravity_headless",sessionId:o.identity.sessionId,identity:{...o.identity},providerSessionId:conversationId,workingDirectory:o.cwd,activeTurnId:started?o.turnId:null};},
        async close(){if(closed)return;closed=true;wake();try{await port!.closeOwned();const exitId=core.store.state.commands.find(c=>c.type==="native_controller.observation"&&c.payload.action==="antigravity.provider_exit")?.commandId;if(!exitId)throw new Error("Antigravity exit receipt missing");await waitCommand(exitId);core.queueCommand("runner.shutdown",{},"antigravity_shutdown",true);await waitCommand("antigravity_shutdown");const exit=await runner!.completion;if(exit.code!==0)throw new Error("Antigravity Runner shutdown failed");runner=undefined;}finally{if(runner){runner.child.kill("SIGTERM");await runner.completion.catch(()=>{});}await core.stop();}},
      };
    }catch(error){await controller?.closeOwned().catch(()=>{});if(runner){runner.child.kill("SIGTERM");await runner.completion.catch(()=>{});}await core.stop();throw error;}
  }
}
