import { api } from "./client";
export interface NativeSessionCatalogEntry {
  source: "paperclip_persisted_run"; companyId:string; runId:string; agentId:string; issueId:string|null;
  driverKind:string|null; normalizedSessionId:string|null; providerSessionId:string|null; providerSessionIdSource:string|null;
  taskSessionId:string|null; runStatus:string; state:"working"|"waiting"|"goal-active"|"paused"|"saved"|"disconnected"|"run-terminal"|"unknown";
  stateEvidence:string; goal:{status:string;observedAt:string}|null; lastOutputAt:string|null;
  capabilities:{nativeLink:null;nativeControl:"unknown";managedSteering:"unknown"};
}
export const nativeSessionsApi={list:(companyId:string)=>api.get<{sessions:NativeSessionCatalogEntry[]}>(`/companies/${encodeURIComponent(companyId)}/native-sessions`)};
