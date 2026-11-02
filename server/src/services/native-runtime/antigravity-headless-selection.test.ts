import { describe, expect, it } from "vitest";
import { resolveNativeRuntimeMode, resolveHeartbeatRuntimeMode } from "./runtime-mode.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
const base={enabled:true,runtimeConfig:{},adapterConfig:{provider:"antigravity_headless",homeMode:"preconfigured"},agent:{status:"running",adapterType:"paperclip_runner"},issue:{id:"issue",workMode:"standard"},target:{kind:"local"},workspaceId:"workspace"} as const;
describe("native Antigravity selection",()=>{
 it("selects the exact native provider, never Codex or ACPX",()=>{
  expect(resolveNativeRuntimeMode(base)).toMatchObject({kind:"native",profile:{backend:"antigravity_headless"}});
  expect(resolveHeartbeatRuntimeMode({persisted:{runtimeMode:null,runtimeModeResolvedAt:null},enabled:true,adapterType:"paperclip_runner",adapterConfig:base.adapterConfig,agentStatus:"running",issue:{workMode:"standard"},executionTarget:{kind:"local"}})).toMatchObject({kind:"native",provider:"antigravity_headless"});
  expect(resolvePaperclipRunnerNativeProviderInput({backend:"antigravity_headless",adapterConfig:base.adapterConfig})).toEqual({provider:"antigravity_headless",model:null,homeMode:"preconfigured"});
 });
 it.each([{model:"chosen"},{homeMode:"isolated"},{acpxAgent:"antigravity"},{reasoningEffort:"low"},{lifecycleMode:"warm"}])("rejects unsupported settings %o",extra=>{
  expect(()=>resolvePaperclipRunnerProviderProfile({...base.adapterConfig,...extra})).toThrow();
 });
 it("denies disabled rollout and mismatched persisted backend",()=>{
  expect(()=>resolveNativeRuntimeMode({...base,enabled:false})).toThrow();
  expect(()=>resolvePaperclipRunnerNativeProviderInput({backend:"codex_app_server",adapterConfig:base.adapterConfig})).toThrow();
 });
});
