import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { startRunnerToolBridge, type RunnerToolCall } from "../runner-tool-bridge.js";

/** Server-issued scope. A bearer alone does not prove the caller's OS process. */
export type AntigravityMcpScope = Readonly<{ companyId:string; issueId:string; runId:string; agentId:string; leaseId:string; normalizedSessionId:string; conversationId:string; processGeneration:string }>;
type InitialScope = Omit<AntigravityMcpScope,"conversationId"|"processGeneration">;
const valid=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&Buffer.byteLength(value)<=256&&!/[\x00-\x1f\x7f]/.test(value);

/** Creates a new private workspace; never modifies an existing project. The server must
 * atomically fence and journal each accepted effect in executeFenced. */
export async function openAntigravityNativeMcpWorkspace(input:{
  privateParent:string; scope:InitialScope; tools:readonly Readonly<Record<string,unknown>>[];
  executeFenced:(scope:AntigravityMcpScope,call:RunnerToolCall)=>Promise<unknown>;
}) {
  const keys=["companyId","issueId","runId","agentId","leaseId","normalizedSessionId"] as const;
  if(!isAbsolute(input.privateParent)||keys.some(k=>!valid(input.scope[k]))||typeof input.executeFenced!=="function")throw new Error("Invalid Antigravity MCP authority");
  const parent=resolve(input.privateParent),st=await lstat(parent);
  if(!st.isDirectory()||st.isSymbolicLink()||(process.platform!=="win32"&&((st.mode&0o077)!==0||st.uid!==process.getuid?.())))throw new Error("Antigravity MCP parent must be private and owned");
  const initial=Object.freeze(Object.fromEntries(keys.map(k=>[k,input.scope[k]])) as InitialScope);
  let scope:AntigravityMcpScope|undefined,closed=false,inflight=0;
  const workspace=await mkdtemp(join(parent,"agy-"));
  const agents=join(workspace,".agents"),configPath=join(agents,"mcp_config.json");
  let configHash="",configInode:bigint|undefined;
  const bridge=await startRunnerToolBridge({tools:input.tools,preserveToolNames:true,timeoutMs:null,handler:async call=>{
    if(closed||!scope)throw new Error("Antigravity MCP conversation not bound");
    const bound=scope;inflight++;
    try{return await input.executeFenced(bound,call);}finally{inflight--;}
  }}).catch(async error=>{await rmdir(workspace).catch(()=>{});throw error;});
  try{
    await mkdir(agents,{mode:0o700});
    // Vendor CLI's documented remote connection field is serverUrl, not url.
    const body=JSON.stringify({mcpServers:{paperclip:{serverUrl:bridge.url,headers:{Authorization:`Bearer ${bridge.secret}`}}}});
    const file=await open(configPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    try{await file.writeFile(body);await file.sync();configInode=(await file.stat({bigint:true})).ino;}finally{await file.close();}
    configHash=createHash("sha256").update(body).digest("hex");
  }catch(error){await bridge.close();await unlink(configPath).catch(()=>{});await rmdir(agents).catch(()=>{});await rmdir(workspace).catch(()=>{});throw error;}
  return Object.freeze({
    workspace,
    /** Only the trusted owner may call this after exact native init/process attestation. */
    bindConversation(value:{conversationId:string;processGeneration:string}){
      if(closed||scope||!valid(value.conversationId)||!valid(value.processGeneration))throw new Error("Antigravity MCP conversation binding refused");
      scope=Object.freeze({...initial,conversationId:value.conversationId,processGeneration:value.processGeneration});
    },
    /** Do not remove a replaced/edited file or tear down tools while calls are live. */
    async close(){
      if(closed)return;if(inflight)throw new Error("Antigravity MCP effects unsettled");
      closed=true;await bridge.close();
      const st=await lstat(configPath,{bigint:true}).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
      if(!st)return;
      if(!st.isFile()||st.isSymbolicLink()||st.ino!==configInode||createHash("sha256").update(await readFile(configPath)).digest("hex")!==configHash)throw new Error("Antigravity MCP owned config changed; preserve for reconciliation");
      await unlink(configPath);await rmdir(agents).catch(error=>{if(error.code!=="ENOTEMPTY")throw error;});
    },
  });
}
