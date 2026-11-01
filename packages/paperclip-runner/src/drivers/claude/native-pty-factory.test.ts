import {createRequire} from "node:module";
import {expect,it,vi} from "vitest";
import {ClaudeNativePtyFactory,nativeSubscriptionEnvironment,verifyClaudePtyGeneration} from "./native-pty-factory.js";
import {ClaudeInteractiveController} from "./native-interactive-controller.js";
const require=createRequire(import.meta.url);
let ptyPath=process.env.CLAUDE_TEST_PTY_MODULE;
if (!ptyPath) { try { ptyPath=require.resolve("node-pty"); } catch { /* dependency may not yet be installed */ } }
it("allows only native subscription settings from inherited and explicit environments",()=>{
  const base={PATH:"/bin",HOME:"/home",CLAUDE_CONFIG_DIR:"/claude",LANG:"en_US.UTF-8",LC_ALL:"C",PAPERCLIP_API_KEY:"secret",PAPERCLIP_BOARD_API_KEY:"secret",PAPERCLIP_RUN_ID:"private",ANTHROPIC_API_KEY:"secret",OPENAI_API_KEY:"secret"};
  const explicit={HOME:"/approved",PAPERCLIP_API_KEY:"secret2",ANTHROPIC_AUTH_TOKEN:"secret",PRIVATE_IDENTITY:"private",XDG_CONFIG_HOME:"/config"};
  expect(nativeSubscriptionEnvironment(base,explicit)).toEqual({PATH:"/bin",HOME:"/approved",CLAUDE_CONFIG_DIR:"/claude",LANG:"en_US.UTF-8",LC_ALL:"C",XDG_CONFIG_HOME:"/config"});
});
it.skipIf(process.platform!=="darwin" || !ptyPath)("routes owner input through the controller to a real PTY",async()=>{
  const module=require(ptyPath!);
  let resolveSeen!:()=>void;
  const seen=new Promise<void>(resolve=>{resolveSeen=resolve;});
  const factory=new ClaudeNativePtyFactory({loadPty:()=>module,onOutput:data=>{if(data.includes("SCO337_OWNER_OK"))resolveSeen();}});
  const id="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
  let owned:Awaited<ReturnType<typeof factory.start>> | undefined;
  const controller=await ClaudeInteractiveController.launch({executable:"/bin/cat",cwd:"/Volumes/NVM/AI_Agent_Runtime/tmp",sessionId:id,model:"sonnet",effort:"low",autoCompactTokens:140000},{start:async input=>{owned=await factory.start({...input,args:[]});return owned;}},{process:verifyClaudePtyGeneration,session:async()=>({sessionId:id,cwd:"/Volumes/NVM/AI_Agent_Runtime/tmp"})},{authorize:async()=>true},{begin:async()=>"reserved",written:async()=>{}});
  try {
    expect(await controller.ownerInput({operationId:"synthetic",text:"SCO337_OWNER_OK\r"})).toEqual({write:"attempted",delivery:"unknown",completion:"unproven",binding:"provisional"});
    await Promise.race([seen,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("PTY output timeout")),3000))]);
  } finally {
    await controller.stopOwnedProcess();
    await vi.waitFor(async()=>expect(await verifyClaudePtyGeneration(owned!.pid,owned!.generation)).toBe(false),{timeout:3000,interval:30});
  }
});
it.skipIf(process.platform!=="darwin" || !ptyPath)("starts a native owned PTY, exchanges harmless text, and stops exactly that process",async()=>{
  const module=require(ptyPath!);
  let sentEnv:Record<string,string> | undefined;
  const wrapped={spawn:(file:string,args:string[],options:{env:Record<string,string>})=>{sentEnv=options.env;return module.spawn(file,args,options);}};
  let resolveSeen!:()=>void;
  const seen=new Promise<void>(resolve=>{resolveSeen=resolve;});
  const factory=new ClaudeNativePtyFactory({loadPty:()=>wrapped,onOutput:data=>{if(data.includes("SCO337_PTY_OK"))resolveSeen();}});
  const pty=await factory.start({executable:"/bin/cat",cwd:"/Volumes/NVM/AI_Agent_Runtime/tmp",args:[],environment:{PAPERCLIP_API_KEY:"never-forward",OPENAI_API_KEY:"never-forward",ANTHROPIC_API_KEY:"never-forward",LC_ALL:"C"}});
  let stopped=false;
  try {
    expect(sentEnv).not.toHaveProperty("PAPERCLIP_API_KEY");
    expect(sentEnv).not.toHaveProperty("PAPERCLIP_BOARD_API_KEY");
    expect(sentEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(sentEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(sentEnv?.LC_ALL).toBe("C");
    expect(await verifyClaudePtyGeneration(pty.pid,pty.generation)).toBe(true);
    pty.writeInput("SCO337_PTY_OK\r");
    await Promise.race([seen,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("PTY output timeout")),3000))]);
    stopped=true;
    await pty.stop();
  } finally {
    if (!stopped && await verifyClaudePtyGeneration(pty.pid,pty.generation)) await pty.stop();
    await vi.waitFor(async()=>expect(await verifyClaudePtyGeneration(pty.pid,pty.generation)).toBe(false),{timeout:3000,interval:30});
  }
});
