import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { prpSchemaBundle } from "../../protocol/generated/schema-bundle.js";
import { eventV2Validator } from "../../protocol/generated/standalone-validators.js";
const eventValidate=eventV2Validator as (v:unknown)=>boolean;
const binding={bindingId:"binding",bindingGeneration:1,runId:"run",environmentLeaseId:"lease",normalizedSessionId:"session",turnId:"turn"};
const event={schema:"paperclip.prp.event.v2",schemaVersion:2,sourceEventId:"event",sourceSeq:1,sourceInstanceId:"runner",sourceKind:"runner",runId:"run",normalizedSessionId:"session",eventType:"native_controller.dispatch_requested",priority:0,emittedAt:"2026-01-01T00:00:00Z",payload:{binding,text:"task",inputDigest:`sha256:${createHash("sha256").update("task").digest("hex")}`}};
const commandSchema=JSON.parse(readFileSync(resolve(import.meta.dirname,"../../../protocol/schemas/command-v2.schema.json"),"utf8"));
const ajv=new Ajv2020({strict:false,validateFormats:false});const commandValidate=ajv.compile(commandSchema);
const command={schema:"paperclip.prp.command.v2",commandId:"result",controllerSeq:1,type:"native_controller.observation",issuedAt:"2026-01-01T00:00:00Z",payload:{...binding,action:"antigravity.native_result",conversationId:"native",processGeneration:"generation",dispatchEventId:"event",result:{status:"SUCCESS"}}};
describe("native controller v2 schema",()=>{
 it("accepts exact dispatch and rejects missing lease or extra fields",()=>{expect(eventValidate(event)).toBe(true);expect(eventValidate({...event,payload:{...event.payload,binding:{...binding,environmentLeaseId:undefined}}})).toBe(false);expect(eventValidate({...event,payload:{...event.payload,extra:true}})).toBe(false);});
 it("accepts bound observation and rejects fake exit and unrelated fields",()=>{expect(commandValidate(command)).toBe(true);expect(commandValidate({...command,payload:{...command.payload,environmentLeaseId:undefined}})).toBe(false);expect(commandValidate({...command,payload:{...command.payload,extra:true}})).toBe(false);const {result,dispatchEventId,...base}=command.payload;expect(commandValidate({...command,payload:{...base,action:"antigravity.provider_exit",exitObserved:false}})).toBe(false);});
});
it("accepts only typed redacted tool observations in v2 and v3",()=>{
 const {result,...base}=command.payload;
 const payload={...base,action:"antigravity.tool_observation",observationId:`sha256:${"a".repeat(64)}`,stepIndex:1,state:"running",toolNameDigest:`sha256:${"b".repeat(64)}`};
 for(const version of [2,3]){const schema=JSON.parse(readFileSync(resolve(import.meta.dirname,`../../../protocol/schemas/command-v${version}.schema.json`),"utf8"));const validator=new Ajv2020({strict:false,validateFormats:false});for(const v of Object.values(prpSchemaBundle))validator.addSchema(v);const validate=validator.getSchema(schema.$id)!;const c={...command,schema:`paperclip.prp.command.v${version}`,payload};expect(validate(c)).toBe(true);expect(validate({...c,payload:{...payload,arguments:"secret"}})).toBe(false);expect(validate({...c,payload:{...payload,toolNameDigest:"plain-name"}})).toBe(false);}
});
