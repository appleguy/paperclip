import express from "express";
import request from "supertest";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {describe,it,expect,vi} from "vitest";
import {ClaudeManagedSessions} from "../services/claude-native-presence.js";
import {claudeNativePresenceRoutes} from "./claude-native-presence.js";
import {errorHandler} from "../middleware/error-handler.js";
import type {LogActivityInput} from "../services/activity-log.js";
const company="55cef09f-ec08-4e71-8e7f-2afb4a912ce8",other="a9ba76d4-c823-4e3e-bc58-50aa7d9f6945",workspaceId="c03cfda9-3b8f-43a8-9e28-4fbc8ff009d4",requestId="16f96c99-ea64-4b83-bac9-c681bbdd281f",operationId="6f4b797c-eb5b-4e0e-9cf8-154ba163ab3e";
const board:Express.Request["actor"]={type:"board",source:"board_key",isInstanceAdmin:true,userId:"owner",companyIds:[company]};
const path=`/api/companies/${company}/native-sessions/claude/managed`;
async function fixture(initial:Express.Request["actor"]){
 const directory=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-managed-test-");let actor=initial;
 const resolveWorkspace=vi.fn(async(c:string,w:string)=>c===company&&w===workspaceId?directory:null);
 const input=vi.fn(async()=>({write:"attempted",delivery:"unknown"})),interrupt=vi.fn(async()=>({interrupt:"attempted",settlement:"unproven"})),detach=vi.fn(async()=>{});
 const control={identity:vi.fn(async()=>({sessionBinding:"provisional",hook:{event:"SessionStart"}})),ownerInput:input,interrupt,settlement:()=>({state:"unproven"}),capabilities:()=>({managedTurns:"unsupported"}),detach};
 const launch=vi.fn(async(_options:Record<string,unknown>)=>control),host=vi.fn(async()=>({claudeExecutable:"/trusted/claude",home:"/trusted"}));
 const managed=new ClaudeManagedSessions({resolveWorkspace,resolveHostSettings:host,stateDirectory:directory,hookHelperExecutable:"/trusted/helper",model:"sonnet",effort:"high",launch});
 const audit=vi.fn(async(_event:LogActivityInput)=>{});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor;next();});app.use("/api",claudeNativePresenceRoutes({resolveHostSettings:host,managedSessions:managed,recordActivity:audit}));app.use(errorHandler);
 return {app,directory,resolveWorkspace,launch,input,interrupt,detach,audit,change:(value:Express.Request["actor"])=>{actor=value;}};
}
describe("managed Claude native route and service",()=>{
 it("rejects unauthenticated, agent, implicit and foreign company actors before host or workspace access",async()=>{for(const actor of [{type:"none"},{type:"agent",source:"agent_key",companyId:company},{...board,source:"local_implicit"},{...board,isInstanceAdmin:false},{...board,companyIds:[]}] as Express.Request["actor"][]){const f=await fixture(actor);try{await request(f.app).post(path).send({requestId,workspaceId}).expect(403);expect(f.resolveWorkspace).not.toHaveBeenCalled();expect(f.launch).not.toHaveBeenCalled();}finally{await rm(f.directory,{recursive:true,force:true});}}});
 it("binds the concrete service to one company, actor, workspace and durable launch request",async()=>{const f=await fixture(board);try{
  const started=await request(f.app).post(path).send({requestId,workspaceId}).expect(201);expect(started.body).toMatchObject({controlSessionId:requestId,source:"paperclip_owned_interactive",identity:{sessionBinding:"provisional"}});
  expect(f.resolveWorkspace).toHaveBeenCalledWith(company,workspaceId);expect(f.launch).toHaveBeenCalledOnce();expect(f.launch.mock.calls[0]![0]).toMatchObject({cwd:f.directory,model:"sonnet",hookHelperExecutable:"/trusted/helper"});
  const launchDirectories=await readdir(f.directory);
  expect(launchDirectories).toHaveLength(1);expect(launchDirectories[0]).toMatch(/^[a-f0-9]{32}$/);
  expect(f.launch.mock.calls[0]![0].journalDirectory).toBe(`${f.directory}/${launchDirectories[0]}`);
  await request(f.app).post(`${path}/${requestId}/input`).send({operationId,text:"hello\r"}).expect(200);expect(f.input).toHaveBeenCalledWith({operationId,text:"hello\r"});
  await request(f.app).post(`${path}/${requestId}/interrupt`).send({operationId}).expect(200);expect(f.interrupt).toHaveBeenCalledWith({operationId});
  f.change({...board,userId:"different"});await request(f.app).post(`${path}/${requestId}/input`).send({operationId,text:"x"}).expect(404);expect(f.input).toHaveBeenCalledTimes(1);
  f.change({...board,companyIds:[company,other]});await request(f.app).get(`/api/companies/${other}/native-sessions/claude/managed/${requestId}`).expect(404);
  f.change(board);await request(f.app).post(`${path}/${requestId}/detach`).send({}).expect(200);expect(f.detach).toHaveBeenCalledOnce();
  await request(f.app).post(path).send({requestId,workspaceId}).expect(409);expect(f.launch).toHaveBeenCalledOnce();
 }finally{await rm(f.directory,{recursive:true,force:true});}});
 it("rejects client host or session selectors before launching",async()=>{const f=await fixture(board);try{await request(f.app).post(path).send({requestId,workspaceId,cwd:"/other"}).expect(400);expect(f.launch).not.toHaveBeenCalled();}finally{await rm(f.directory,{recursive:true,force:true});}});
 it("routes through the real Runner controller with a test-only PTY session",async()=>{
  const runnerPath=new URL("../../../packages/paperclip-runner/src/drivers/claude/native-interactive-runner.ts",import.meta.url).href,sessionPath=new URL("../../../packages/paperclip-runner/src/drivers/claude/native-interactive-session.ts",import.meta.url).href;
  const {ClaudeInteractiveRunner}=await import(runnerPath),{ClaudeInteractiveSession}=await import(sessionPath);
  const directory=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-managed-chain-");
  const input=vi.fn(async()=>({write:"attempted",delivery:"unknown",completion:"unproven",binding:"provisional"}));
  const spy=vi.spyOn(ClaudeInteractiveSession,"launch").mockImplementation(async(...args:unknown[])=>{const options=args[0] as {sessionId:string};return {hookStart:{sessionId:options.sessionId,event:"SessionStart",peer:"darwin-kernel-pid-uid-and-live-ancestry",namespace:"parent-attested-launch-scope"},observe:async()=>({nativeSessionId:options.sessionId,processGeneration:"123:birth",identity:"provisional",remoteControl:"requested_connection_unverified"}),ownerInput:input,detach:async()=>{}};});
  try {
   const managed=new ClaudeManagedSessions({stateDirectory:directory,hookHelperExecutable:"/trusted/helper",model:"sonnet",effort:"high",resolveHostSettings:async()=>({claudeExecutable:"/trusted/claude",home:"/trusted"}),resolveWorkspace:async()=>directory,launch:async options=>ClaudeInteractiveRunner.launch(options)});
   const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=board;next();});app.use("/api",claudeNativePresenceRoutes({resolveHostSettings:async()=>({claudeExecutable:"/trusted/claude",home:"/trusted"}),managedSessions:managed}));app.use(errorHandler);
   const response=await request(app).post(path).send({requestId,workspaceId}).expect(201);expect(response.body.identity).toMatchObject({sessionBinding:"provisional",hook:{event:"SessionStart"}});
   const result=await request(app).post(`${path}/${requestId}/interrupt`).send({operationId}).expect(200);expect(result.body).toMatchObject({interrupt:"attempted",settlement:"unproven"});expect(input).toHaveBeenCalledWith({operationId,text:"\u0003"});
  } finally {spy.mockRestore();await rm(directory,{recursive:true,force:true});}
 });
 it("audits operation identity without private input and marks failed writes uncertain",async()=>{
  const f=await fixture(board);try {
   await request(f.app).post(path).send({requestId,workspaceId}).expect(201);
   f.input.mockRejectedValueOnce(new Error("private provider failure"));
   await request(f.app).post(`${path}/${requestId}/input`).send({operationId,text:"private owner objective"}).expect(500);
   const events=f.audit.mock.calls.map(call=>call[0]);
   expect(events.map(event=>event.action)).toEqual(["native_session.claude_launch_requested","native_session.claude_launch_returned","native_session.claude_input_requested","native_session.claude_input_uncertain"]);
   expect(events[2]).toMatchObject({companyId:company,actorId:"owner",entityId:requestId,details:{operationId}});
   expect(JSON.stringify(events)).not.toMatch(/private owner objective|private provider failure/);
   f.audit.mockRejectedValueOnce(new Error("audit unavailable"));
   await request(f.app).post(`${path}/${requestId}/input`).send({operationId,text:"another input"}).expect(500);
   expect(f.input).toHaveBeenCalledOnce();
  } finally {await rm(f.directory,{recursive:true,force:true});}
 });
 it("refuses an unconfigured model before creating a launch reservation",async()=>{
  const f=await fixture(board);try {
   const launch=vi.fn();const managed=new ClaudeManagedSessions({stateDirectory:f.directory,hookHelperExecutable:"/trusted/helper",model:"",effort:"high",resolveHostSettings:async()=>({claudeExecutable:"/trusted/claude",home:"/trusted"}),resolveWorkspace:async()=>f.directory,launch});
   await expect(managed.start({companyId:company,actorId:"owner",requestId,workspaceId})).rejects.toThrow("explicitly configured");
   expect(await readdir(f.directory)).toEqual([]);expect(launch).not.toHaveBeenCalled();
  } finally {await rm(f.directory,{recursive:true,force:true});}
 });
});
