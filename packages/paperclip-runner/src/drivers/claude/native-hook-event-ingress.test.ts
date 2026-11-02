import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {execFileSync,spawn} from "node:child_process";
import {once} from "node:events";
import {chmod,mkdtemp,readFile,readdir,realpath,rm,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {ClaudeHookEventIngress} from "./native-hook-event-ingress.js";
import {claudePtyProcessGeneration} from "./native-pty-factory.js";
const id="12345678-1234-4234-8234-123456789abc",prompt="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe.skipIf(process.platform!=="darwin")("owned descendant hook event ingress",()=>{
 let root:string,binary:string,executable:string;
 beforeAll(async()=>{root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/events-test-");binary=join(root,"helper");executable=await realpath("/bin/sh");execFileSync("go",["build","-trimpath","-o",binary,"."],{cwd:resolve("tools/claude-hook-binding"),env:{...process.env,GOARM64:"v8.1",CGO_ENABLED:"0"},timeout:30000});},40000);
 afterAll(async()=>{await rm(root,{recursive:true,force:true});});
 it("persists an owned child event before its acknowledgment and strips text",async()=>{
  const dir=await mkdtemp(join(root,"session-")),ingress=await ClaudeHookEventIngress.prepare({directory:dir,executable:binary});
  const payload=JSON.stringify({session_id:id,cwd:await realpath(dir),hook_event_name:"PreToolUse",prompt_id:prompt,tool_use_id:"toolu_1",prompt:"private-prompt-canary",tool_input:{command:"private-command-canary"}});
  const child=spawn(executable,["-c",'while IFS= read -r line; do printf "%s" "$PAYLOAD" | "$HELPER" send-event; printf "exit:%s\\n" "$?"; done'],{cwd:dir,stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",PAYLOAD:payload,HELPER:binary,CLAUDE_HOOK_SOCKET:ingress.socketPath,CLAUDE_HOOK_NONCE_FILE:ingress.nonceFile}});
  try{const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("missing generation");await ingress.start({sessionId:id,launchScope:{pid:child.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope"}});
   child.stdin.write("go\n");const [bytes]=await once(child.stdout,"data") as [Buffer];expect(bytes.toString()).toContain("exit:0");
   const snapshot=await ingress.snapshot();expect(snapshot).toMatchObject({origin:"unattributed",settlement:"unproven",coverage:"incomplete"});expect(snapshot.events).toContainEqual(expect.objectContaining({event:"PreToolUse",promptId:prompt,toolUseId:"toolu_1"}));
   const name=(await readdir(dir)).find(name=>name.startsWith("claude-observation-"))!;const stored=await readFile(join(dir,name),"utf8");expect(stored).not.toContain("private-");expect(ingress.status().provenance).toBe("owned-descendant-attributed");
   await ingress.recordOwnerAttempt({deliveryKey:"owner-operation",operationId:"operation",action:"interrupt"});expect((await ingress.snapshot()).settlement).toBe("unproven");
  }finally{await ingress.close();child.stdin.end();await once(child,"close");}
 },30000);
 it("rejects a same-UID peer outside the exact owner ancestry",async()=>{
  const dir=await mkdtemp(join(root,"outsider-")),ingress=await ClaudeHookEventIngress.prepare({directory:dir,executable:binary}),script=join(dir,"outsider.cjs");
  await writeFile(script,`const net=require('node:net'),fs=require('node:fs');const body=JSON.stringify({hook:JSON.parse(process.env.PAYLOAD),nonce:fs.readFileSync(process.env.NONCE,'utf8'),deliveryKey:'b'.repeat(64)});const c=net.createConnection(process.env.SOCKET,()=>c.end(body));c.on('data',()=>{});c.on('end',()=>process.exit(0));c.on('error',()=>process.exit(0));`);
  const owner=spawn(executable,["-c",'while IFS= read -r line; do :; done'],{cwd:dir,stdio:["pipe","ignore","ignore"]});
  try {const generation=await claudePtyProcessGeneration(owner.pid!);if(!generation)throw new Error("missing generation");await ingress.start({sessionId:id,launchScope:{pid:owner.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope"}});
   const payload=JSON.stringify({session_id:id,cwd:await realpath(dir),hook_event_name:"UserPromptSubmit",prompt_id:prompt});const outsider=spawn(process.execPath,[script],{env:{PATH:"/usr/bin:/bin",PAYLOAD:payload,SOCKET:ingress.socketPath,NONCE:ingress.nonceFile},stdio:"ignore"});await once(outsider,"close");
   await new Promise(resolve=>setTimeout(resolve,100));expect((await ingress.snapshot()).events).toHaveLength(0);expect(ingress.status().state).toBe("failed");
  }finally{await ingress.close();owner.stdin.end();await once(owner,"close");}
 },30000);
 it("deduplicates a sender retry after the first acknowledgment is lost",async()=>{
  const dir=await mkdtemp(join(root,"replay-")),ingress=await ClaudeHookEventIngress.prepare({directory:dir,executable:binary}),script=join(dir,"retry.cjs");
  await writeFile(script,`const net=require('node:net'),fs=require('node:fs');const hook=JSON.parse(process.env.PAYLOAD),nonce=fs.readFileSync(process.env.NONCE,'utf8');const body=JSON.stringify({hook,nonce,deliveryKey:'a'.repeat(64)});const first=net.createConnection(process.env.SOCKET,()=>first.end(body,()=>first.destroy()));first.on('error',()=>{});setTimeout(()=>{const c=net.createConnection(process.env.SOCKET,()=>c.end(body));let r='';c.on('data',b=>r+=b);c.on('end',()=>process.exit(r==='OK\\n'?0:2));c.on('error',()=>process.exit(3));},800);`);
  const payload=JSON.stringify({session_id:id,cwd:await realpath(dir),hook_event_name:"UserPromptSubmit",prompt_id:prompt});
  const child=spawn(executable,["-c",'while IFS= read -r line; do "$NODE" "$SCRIPT"; printf "exit:%s\\n" "$?"; done'],{cwd:dir,stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",PAYLOAD:payload,NODE:process.execPath,SCRIPT:script,SOCKET:ingress.socketPath,NONCE:ingress.nonceFile}});
  try{const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("missing generation");await ingress.start({sessionId:id,launchScope:{pid:child.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope"}});
   child.stdin.write("go\n");const [bytes]=await once(child.stdout,"data") as [Buffer];expect(bytes.toString()).toContain("exit:0");expect((await ingress.snapshot()).events).toHaveLength(1);expect(ingress.status().state).toBe("ready");
  }finally{await ingress.close();child.stdin.end();await once(child,"close");}
 },30000);
 it("does not acknowledge when the durable append fails",async()=>{
  const dir=await mkdtemp(join(root,"failure-")),ingress=await ClaudeHookEventIngress.prepare({directory:dir,executable:binary});
  const payload=JSON.stringify({session_id:id,cwd:await realpath(dir),hook_event_name:"UserPromptSubmit",prompt_id:prompt});
  const child=spawn(executable,["-c",'while IFS= read -r line; do printf "%s" "$PAYLOAD" | "$HELPER" send-event; printf "exit:%s\\n" "$?"; done'],{cwd:dir,stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",PAYLOAD:payload,HELPER:binary,CLAUDE_HOOK_SOCKET:ingress.socketPath,CLAUDE_HOOK_NONCE_FILE:ingress.nonceFile}});
  try{const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("missing generation");await ingress.start({sessionId:id,launchScope:{pid:child.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope"}});
   await chmod(dir,0o755);child.stdin.write("go\n");const [bytes]=await once(child.stdout,"data") as [Buffer];expect(bytes.toString()).toContain("exit:1");await chmod(dir,0o700);expect((await ingress.snapshot()).events).toHaveLength(0);expect(ingress.status().state).toBe("failed");
  }finally{await chmod(dir,0o700);await ingress.close();child.stdin.end();await once(child,"close");}
 },30000);
 it("rejects an owned descendant carrying a foreign session without persisting",async()=>{
  const dir=await mkdtemp(join(root,"foreign-")),ingress=await ClaudeHookEventIngress.prepare({directory:dir,executable:binary});
  const payload=JSON.stringify({session_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",cwd:await realpath(dir),hook_event_name:"UserPromptSubmit",prompt_id:prompt});
  const child=spawn(executable,["-c",'while IFS= read -r line; do printf "%s" "$PAYLOAD" | "$HELPER" send-event; printf "exit:%s\\n" "$?"; done'],{cwd:dir,stdio:["pipe","pipe","ignore"],env:{PATH:"/usr/bin:/bin",PAYLOAD:payload,HELPER:binary,CLAUDE_HOOK_SOCKET:ingress.socketPath,CLAUDE_HOOK_NONCE_FILE:ingress.nonceFile}});
  try{const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("missing generation");await ingress.start({sessionId:id,launchScope:{pid:child.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope"}});
   child.stdin.write("go\n");const [bytes]=await once(child.stdout,"data") as [Buffer];expect(bytes.toString()).toContain("exit:1");expect((await ingress.snapshot()).events).toHaveLength(0);expect(ingress.status().state).toBe("failed");
  }finally{await ingress.close();child.stdin.end();await once(child,"close");}
 },30000);
});
