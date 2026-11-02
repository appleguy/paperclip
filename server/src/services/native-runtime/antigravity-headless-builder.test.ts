import { expect, it } from "vitest";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
it("builds an explicit native-headless v11 execution without authority claims",()=>{
 const runId="50000000-0000-4000-8000-000000000005";
 const input=buildNativeExecutionInput({companyId:"10000000-0000-4000-8000-000000000001",runId,agentId:"30000000-0000-4000-8000-000000000003",issue:{id:"20000000-0000-4000-8000-000000000002",identifier:"I",title:"Task",description:null,workMode:"standard"},taskPrompt:"Task",workspace:{id:"50000000-0000-4000-8000-000000000005",cwd:"/workspace",repoUrl:null,repoRef:null,branchName:null},normalizedSessionId:null,provider:"antigravity_headless",completionContract:{id:"c",sha256:"sha256:"+"a".repeat(64),schemaVersion:"v1",contract:{revision:"1",objective:"Task",criteria:[{id:"c",requirement:"Done"}]}},runtimeContext:nativeRuntimeContextFixture()});
 expect(input).toMatchObject({schema:"paperclip.native-execution-input.v11",provider:{kind:"antigravity_headless",model:null,cliVersion:"1.4.12"},session:{normalizedSessionId:`session-${runId}`,driverKind:"antigravity_headless",lifecyclePolicy:{mode:"per_turn"}}});
 expect(input.provider).not.toHaveProperty("leaseId");
});
