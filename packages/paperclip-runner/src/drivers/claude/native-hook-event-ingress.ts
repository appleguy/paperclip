import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomBytes} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,unlink} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";
import {ClaudePromptObservation,type ClaudeNativeObservation} from "./native-prompt-observation.js";
import type {ClaudeNativePty} from "./native-pty-factory.js";

/** One finite helper per owned session. Kernel credentials and ancestry identify
 * a descendant, not necessarily Claude's hook: tools may be descendants too.
 * This interface never claims provider-authenticated events or PRP settlement. */
export class ClaudeHookEventIngress {
 readonly socketPath:string;readonly nonceFile:string;
 readonly provenance="owned-descendant-attributed" as const;
 private child?:ChildProcessWithoutNullStreams;private observer?:ClaudePromptObservation;
 private started=false;private stopping=false;private state:"prepared"|"ready"|"closed"|"failed"="prepared";
 private constructor(private readonly directory:string,private readonly executable:string,private readonly nonce:string){this.socketPath=join(directory,`ev-${nonce.slice(0,16)}.sock`);this.nonceFile=join(directory,`ev-${nonce.slice(0,16)}.nonce`);}
 static async prepare(input:{directory:string;executable:string}) {
  if(!isAbsolute(input.directory)||!isAbsolute(input.executable))throw new Error("invalid hook ingress paths");const dir=resolve(input.directory),st=await lstat(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new Error("hook ingress directory must be private and owned");
  const result=new ClaudeHookEventIngress(dir,resolve(input.executable),randomBytes(32).toString("hex"));if(process.platform==="darwin"&&Buffer.byteLength(result.socketPath)>=104)throw new Error("hook ingress socket path exceeds Darwin limit");
  const f=await open(result.nonceFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{await f.writeFile(result.nonce);await f.sync();}finally{await f.close();}return result;
 }
 /** Use for the documented hook events in the launch settings. No nonce value,
  * Paperclip credential or input text is present in the command. */
 hookCommand():string {const quote=(v:string)=>`'${v.replaceAll("'","'\\''")}'`;return `CLAUDE_HOOK_SOCKET=${quote(this.socketPath)} CLAUDE_HOOK_NONCE_FILE=${quote(this.nonceFile)} ${quote(this.executable)} send-event`;}
 status(){return {state:this.state,provenance:this.provenance,settlement:"unproven",coverage:"incomplete"} as const;}
 async start(input:{sessionId:string;launchScope:ClaudeNativePty["launchScope"]}):Promise<void> {
  if(this.started)throw new Error("hook ingress already used");this.started=true;const s=Object.freeze({...input.launchScope}),sessionId=input.sessionId;
  if(s.source!=="parent-attested-launch-scope"||!Number.isSafeInteger(s.pid)||s.pid<1||!s.generation||![s.executable,s.cwd,s.home,s.config].every(isAbsolute))throw new Error("invalid hook launch scope");
  this.observer=new ClaudePromptObservation({directory:this.directory,sessionId,processGeneration:s.generation});
  const child=spawn(this.executable,["events"],{stdio:["pipe","pipe","pipe"],env:{PATH:"/usr/bin:/bin:/usr/sbin",LC_ALL:"C"}});this.child=child;child.stderr.resume();
  let buffer="",chain=Promise.resolve(),readyResolve!:()=>void,readyReject!:(error:Error)=>void,ready=false;
  const readyPromise=new Promise<void>((resolveReady,rejectReady)=>{readyResolve=resolveReady;readyReject=rejectReady;});
  const fail=()=>{if(this.state!=="closed")this.state="failed";if(!ready)readyReject(new Error("hook ingress unavailable"));child.kill("SIGTERM");};
  child.on("error",fail);child.stdin.on("error",fail);child.on("close",()=>{if(this.stopping)this.state="closed";else fail();});
  child.stdout.on("data",(chunk:Buffer)=>{buffer+=chunk.toString("utf8");if(Buffer.byteLength(buffer)>8192){fail();return;}let end:number;
   while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);chain=chain.then(async()=>{
    let frame:Record<string,unknown>;try{frame=JSON.parse(line);}catch{throw new Error("invalid hook ingress frame");}
    if(!ready){if(frame.type!=="ready")throw new Error("invalid hook ingress startup");ready=true;this.state="ready";readyResolve();return;}
    if(frame.type!=="event"||typeof frame.deliveryKey!=="string"||frame.sessionId!==sessionId||frame.processGeneration!==s.generation)throw new Error("invalid hook ingress binding");
    const event:ClaudeNativeObservation={kind:"hook",deliveryKey:frame.deliveryKey,sessionId,processGeneration:s.generation,event:frame.event as ClaudeNativeObservation["event"],promptId:frame.promptId as string|null,toolUseId:frame.toolUseId as string|null,agentId:frame.agentId as string|null,interrupted:frame.interrupted as boolean|null};
    await this.observer!.append(event);if(child.stdin.destroyed)throw new Error("hook ingress closed");child.stdin.write(JSON.stringify({deliveryKey:event.deliveryKey,status:"persisted"})+"\n");
   }).catch(fail);}
  });
  child.stdin.write(JSON.stringify({socket:this.socketPath,nonce:this.nonce,sessionID:sessionId,...s})+"\n");
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([readyPromise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("hook ingress startup deadline")),8000);})]);}catch(error){fail();await this.close();throw error;}finally{if(timer)clearTimeout(timer);}
 }
 async snapshot(){if(!this.observer)throw new Error("hook ingress not started");return this.observer.snapshot();}
 async recordOwnerAttempt(input:{deliveryKey:string;operationId:string;action:"input"|"interrupt"}) {if(!this.observer||this.state!=="ready")throw new Error("hook ingress unavailable");return this.observer.append({kind:"owner_attempt",...input});}
 async close(){if(this.stopping)return;this.stopping=true;const child=this.child;if(child&&child.exitCode===null&&child.signalCode===null){child.stdin.end();await new Promise<void>(done=>{const timer=setTimeout(()=>{child.kill("SIGTERM");done();},2000);child.once("close",()=>{clearTimeout(timer);done();});});}this.state="closed";await unlink(this.nonceFile).catch(()=>{});}
}
