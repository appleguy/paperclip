import {describe,it,expect} from "vitest";
import {mkdtemp,readdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {ClaudePromptObservation} from "./native-prompt-observation.js";
const sessionId="12345678-1234-4234-8234-123456789abc",promptId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",processGeneration="123:birth";
async function fixture(){const directory=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-observe-");return {directory,observer:new ClaudePromptObservation({directory,sessionId,processGeneration})};}
describe("Claude native prompt observation",()=>{
 it("persists native prompt and tool provenance without assigning owner attribution or settlement",async()=>{const {directory,observer}=await fixture();try{
  await observer.append({kind:"owner_attempt",deliveryKey:"owner-1",operationId:"operation-1",action:"input"});
  await observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"hook-1",event:"UserPromptSubmit",promptId,toolUseId:null,agentId:null,interrupted:null});
  await observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"hook-2",event:"PreToolUse",promptId,toolUseId:"toolu_1",agentId:null,interrupted:null});
  await observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"hook-3",event:"PostToolUse",promptId,toolUseId:"toolu_1",agentId:null,interrupted:null});
  await observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"hook-4",event:"Stop",promptId,toolUseId:null,agentId:null,interrupted:null});
  const restarted=new ClaudePromptObservation({directory,sessionId,processGeneration}),snapshot=await restarted.snapshot();
  expect(snapshot).toMatchObject({origin:"unattributed",settlement:"unproven",coverage:"incomplete"});expect(snapshot.events).toHaveLength(5);
  expect(snapshot.events).toContainEqual(expect.objectContaining({event:"PreToolUse",promptId,toolUseId:"toolu_1"}));
  expect(snapshot.events).toContainEqual(expect.objectContaining({kind:"owner_attempt",operationId:"operation-1"}));
 }finally{await rm(directory,{recursive:true,force:true});}});
 it("deduplicates only an exact stable delivery key and rejects changed events",async()=>{const {directory,observer}=await fixture();try{
  const event={kind:"hook" as const,sessionId,processGeneration,deliveryKey:"delivery",event:"UserPromptSubmit" as const,promptId,toolUseId:null,agentId:null,interrupted:null};
  expect(await observer.append(event)).toBe("recorded");expect(await observer.append(event)).toBe("duplicate");
  await expect(observer.append({...event,deliveryKey:"foreign",sessionId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"})).rejects.toThrow("binding mismatch");
  await expect(observer.append({...event,deliveryKey:"stale",processGeneration:"123:other"})).rejects.toThrow("binding mismatch");
  await expect(observer.append({...event,promptId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"})).rejects.toThrow("conflict or uncertain");expect((await observer.snapshot()).events).toHaveLength(1);
 }finally{await rm(directory,{recursive:true,force:true});}});
 it("retains interrupt and permission denial as facts without inventing missing Stop or complete tool coverage",async()=>{const {directory,observer}=await fixture();try{
  await observer.append({kind:"owner_attempt",deliveryKey:"interrupt",operationId:"op",action:"interrupt"});
  await observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"denied",event:"PermissionDenied",promptId,toolUseId:"toolu_denied",agentId:null,interrupted:null});
  const result=await observer.snapshot();expect(result.events).toHaveLength(2);expect(result.events.some(event=>event.kind==="hook"&&event.event==="Stop")).toBe(false);expect(result.settlement).toBe("unproven");expect(result.coverage).toBe("incomplete");
  await expect(observer.append({kind:"hook",sessionId,processGeneration,deliveryKey:"invalid",event:"PostToolUse",promptId,toolUseId:null,agentId:null,interrupted:null})).rejects.toThrow("tool observation");
 }finally{await rm(directory,{recursive:true,force:true});}});
 it("fails closed on partial journal writes and mismatched process generation",async()=>{const {directory,observer}=await fixture();try{
  const event={kind:"owner_attempt" as const,deliveryKey:"key",operationId:"op",action:"input" as const};await observer.append(event);
  const file=(await readdir(directory)).find(name=>name.startsWith("claude-observation-"))!;await writeFile(join(directory,file),"{");
  await expect(observer.append(event)).rejects.toThrow("conflict or uncertain");await expect(observer.snapshot()).rejects.toThrow("unavailable");
 }finally{await rm(directory,{recursive:true,force:true});}
 const second=await fixture();try{await second.observer.append({kind:"owner_attempt",deliveryKey:"owner",operationId:"op",action:"input"});await expect(new ClaudePromptObservation({directory:second.directory,sessionId,processGeneration:"123:other"}).snapshot()).rejects.toThrow("binding mismatch");}finally{await rm(second.directory,{recursive:true,force:true});}});
});
