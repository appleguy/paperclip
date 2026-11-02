import {describe,it,expect,beforeAll,afterAll} from "vitest";
import {execFileSync,spawn} from "node:child_process";
import {mkdir,mkdtemp,rm,realpath,readdir,writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join,resolve} from "node:path";
import {ClaudeNativeHookProcess} from "./native-hook-process.js";
import {claudePtyProcessGeneration} from "./native-pty-factory.js";
const session="12345678-1234-4234-8234-123456789abc";
describe.skipIf(process.platform!=="darwin")("finite native hook process",()=>{
 let root:string,binary:string,executable:string;
 beforeAll(async()=>{root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/hook-process-test-");binary=join(root,"helper");executable=await realpath("/bin/sh");execFileSync("go",["build","-trimpath","-o",binary,"."],{cwd:resolve("tools/claude-hook-binding"),env:{...process.env,GOARM64:"v8.1",CGO_ENABLED:"0"},timeout:30000});},40000);
 afterAll(async()=>{await rm(root,{recursive:true,force:true});});
 async function run(claimedSession=session){
   const dir=await mkdtemp(join(root,"run-")), hook=await ClaudeNativeHookProcess.prepare({directory:dir,executable:binary});
   const child=spawn(executable,["-c",'printf \'{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart"}\' "$SESSION" "$PWD" | "$HELPER" send; :'],{cwd:dir,stdio:"ignore",env:{PATH:"/usr/bin:/bin",HELPER:binary,SESSION:claimedSession,CLAUDE_HOOK_SOCKET:hook.socketPath,CLAUDE_HOOK_NONCE_FILE:hook.nonceFile}});
   const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("test process unavailable");
   const launchScope={pid:child.pid!,generation,executable,cwd:await realpath(dir),home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope" as const};
   return {hook,child,launchScope};
 }
 it("accepts the exact child peer and prevents reuse",async()=>{const {hook,child,launchScope}=await run();try {expect(await hook.bind({sessionId:session,launchScope})).toMatchObject({sessionId:session,event:"SessionStart",namespace:"parent-attested-launch-scope"});await expect(hook.bind({sessionId:session,launchScope})).rejects.toThrow("already used");} finally {child.kill();}},30000);
 it("rejects an altered hook session",async()=>{const {hook,child,launchScope}=await run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");try {await expect(hook.bind({sessionId:session,launchScope})).rejects.toThrow("rejected");} finally {child.kill();}},30000);
 it("leaves a durable uncertain reservation when the helper fails",async()=>{
   const dir=await mkdtemp(join(root,"failed-")),hook=await ClaudeNativeHookProcess.prepare({directory:dir,executable:"/usr/bin/false"});
   const generation=(await claudePtyProcessGeneration(process.pid))!;
   const launchScope={pid:process.pid,generation,executable:"/usr/bin/false",cwd:dir,home:dir,config:join(dir,"config"),source:"parent-attested-launch-scope" as const};
   await expect(hook.bind({sessionId:session,launchScope})).rejects.toThrow();
   const names=await readdir(dir);expect(names.filter(name=>name.endsWith(".reservation"))).toHaveLength(1);expect(names.some(name=>name.endsWith(".written"))).toBe(false);expect(names.some(name=>name.endsWith(".nonce"))).toBe(false);
   await expect(hook.bind({sessionId:session,launchScope})).rejects.toThrow("already used");
 });
 it.skipIf(!existsSync("/opt/homebrew/bin/claude"))("binds a real no-login Claude init-only SessionStart",async()=>{
   const dir=await mkdtemp(join(root,"claude-")), config=join(dir,"config");await mkdir(config);
   const helper=await ClaudeNativeHookProcess.prepare({directory:dir,executable:binary}), claude=await realpath("/opt/homebrew/bin/claude"), settings=join(dir,"settings.json");
   await writeFile(settings,JSON.stringify({hooks:{SessionStart:[{matcher:"startup",hooks:[{type:"command",command:helper.sessionStartCommand(),timeout:15}]}]}}));
   const child=spawn(claude,["--init-only","--session-id",session,"--setting-sources","","--settings",settings],{cwd:dir,stdio:"ignore",env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:dir,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",LANG:"C"}});
   const generation=await claudePtyProcessGeneration(child.pid!);if(!generation)throw new Error("Claude test process unavailable");
   const launchScope={pid:child.pid!,generation,executable:claude,cwd:await realpath(dir),home:dir,config,source:"parent-attested-launch-scope" as const};
   try {expect(await helper.bind({sessionId:session,launchScope})).toMatchObject({sessionId:session,event:"SessionStart"});}finally{child.kill();}
 },30000);
});
