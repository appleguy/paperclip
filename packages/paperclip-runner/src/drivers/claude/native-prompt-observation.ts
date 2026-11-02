import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,readdir,readFile} from "node:fs/promises";
import {isAbsolute,join,resolve} from "node:path";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
const kinds=["UserPromptSubmit","PreToolUse","PostToolUse","PostToolUseFailure","PermissionDenied","Stop","StopFailure"] as const;
export type ClaudeObservedHookKind=typeof kinds[number];
export type ClaudeNativeObservation={kind:"hook";deliveryKey:string;sessionId:string;processGeneration:string;event:ClaudeObservedHookKind;promptId:string|null;toolUseId:string|null;agentId:string|null;interrupted:boolean|null};
export type ClaudeOwnerAttemptObservation={kind:"owner_attempt";deliveryKey:string;operationId:string;action:"input"|"interrupt"};
export type ClaudeObservation=ClaudeNativeObservation|ClaudeOwnerAttemptObservation;
type Observation=ClaudeObservation;
type BoundRecord={schema:"paperclip.claude.prompt-observation.v1";sessionId:string;processGeneration:string;observation:Observation};
const token=(value:unknown,max:number)=>typeof value==="string"&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const optionalToken=(value:unknown,max:number)=>value===null||token(value,max);
function canonical(o:Observation):Observation {
 if(!token(o.deliveryKey,128)) throw new Error("invalid Claude observation delivery key");
 if(o.kind==="owner_attempt") {
  if(!token(o.operationId,128)||!(o.action==="input"||o.action==="interrupt"))throw new Error("invalid owner attempt");
  return {kind:"owner_attempt",deliveryKey:o.deliveryKey,operationId:o.operationId,action:o.action};
 }
 if(o.kind!=="hook"||!uuid.test(o.sessionId)||!token(o.processGeneration,1024)||!kinds.includes(o.event)||!(o.promptId===null||uuid.test(o.promptId))||!optionalToken(o.agentId,128)||!optionalToken(o.toolUseId,256)||!(o.interrupted===null||typeof o.interrupted==="boolean"))throw new Error("invalid native hook observation");
 const tool=["PreToolUse","PostToolUse","PostToolUseFailure","PermissionDenied"].includes(o.event);
 if(tool!==!!o.toolUseId || (o.interrupted!==null && o.event!=="PostToolUseFailure"))throw new Error("invalid native tool observation");
 return {kind:"hook",deliveryKey:o.deliveryKey,sessionId:o.sessionId,processGeneration:o.processGeneration,event:o.event,promptId:o.promptId,toolUseId:o.toolUseId,agentId:o.agentId,interrupted:o.interrupted};
}

/** Observation-only records in the existing Runner-owned journal directory.
 * Caller MUST authenticate hook peer + exact process/session before recording;
 * this class cannot authenticate hook payloads. deliveryKey is assigned by an
 * ingress that can replay the same key. Hooks do not supply such a key, so no
 * exactly-once claim applies when the upstream cannot retain one. No text,
 * transcript, tool inputs/outputs, credentials or inferred origin is stored. */
export class ClaudePromptObservation {
 private readonly directory:string;
 private readonly sessionId:string;
 private readonly generation:string;
 constructor(input:{directory:string;sessionId:string;processGeneration:string}) {
  if(!isAbsolute(input.directory)||!uuid.test(input.sessionId)||!token(input.processGeneration,1024))throw new Error("invalid Claude observation binding");
  this.directory=resolve(input.directory);this.sessionId=input.sessionId;this.generation=input.processGeneration;
 }
 private async privateDirectory(){const st=await lstat(this.directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new Error("Claude observation directory must be private and owned");}
 private record(o:Observation):BoundRecord{const observation=canonical(o);if(observation.kind==="hook"&&(observation.sessionId!==this.sessionId||observation.processGeneration!==this.generation))throw new Error("Claude observation binding mismatch");return {schema:"paperclip.claude.prompt-observation.v1",sessionId:this.sessionId,processGeneration:this.generation,observation};}
 async append(input:Observation):Promise<"recorded"|"duplicate"> {
  const record=this.record(input),data=JSON.stringify(record);if(Buffer.byteLength(data)>4096)throw new Error("Claude observation too large");await this.privateDirectory();
  const path=join(this.directory,`claude-observation-${digest(record.observation.deliveryKey)}.json`);
  let file;try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(error){
   if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
   const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>4096||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new Error("Claude observation conflict or uncertain write");
   const previous=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   try{if(await previous.readFile("utf8")!==data)throw new Error("Claude observation conflict or uncertain write");await previous.sync();}finally{await previous.close();}
   const dir=await open(this.directory,"r");try{await dir.sync();}finally{await dir.close();}return "duplicate";
  }
  try{await file.writeFile(data,"utf8");await file.sync();}finally{await file.close();}
  const dir=await open(this.directory,"r");try{await dir.sync();}finally{await dir.close();}return "recorded";
 }
 /** Reads immutable facts, not a timeline. Missing hooks prove nothing. */
 async snapshot():Promise<{events:Observation[];origin:"unattributed";settlement:"unproven";coverage:"incomplete"}> {
  await this.privateDirectory();const files=(await readdir(this.directory)).filter(name=>/^claude-observation-[0-9a-f]{64}\.json$/.test(name));if(files.length>4096)throw new Error("too many Claude observations");
  const events:Observation[]=[];
  for(const name of files){const path=join(this.directory,name),st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>4096||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new Error("Claude observation unavailable");
   let parsed:BoundRecord;try{parsed=JSON.parse(await readFile(path,"utf8")) as BoundRecord;}catch{throw new Error("Claude observation unavailable");}
   if(parsed.schema!=="paperclip.claude.prompt-observation.v1"||parsed.sessionId!==this.sessionId||parsed.processGeneration!==this.generation)throw new Error("Claude observation binding mismatch");
   const canonicalRecord=this.record(parsed.observation);if(name!==`claude-observation-${digest(canonicalRecord.observation.deliveryKey)}.json`||JSON.stringify(parsed)!==JSON.stringify(canonicalRecord))throw new Error("Claude observation unavailable");events.push(canonicalRecord.observation);
  }
  return {events,origin:"unattributed",settlement:"unproven",coverage:"incomplete"};
 }
}
