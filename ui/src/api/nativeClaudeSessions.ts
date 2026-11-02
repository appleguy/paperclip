import { api } from "./client";

export interface NativeClaudeSession {
  sessionId: string;
  source: "observed_external";
  kind: string;
  status: string;
  remoteControl: "unknown";
  ownerIntervention: "vendor_native_unverified";
}

export interface NativeClaudeSessionsResponse {
  sessions: NativeClaudeSession[];
  truncated: boolean;
}

export interface ManagedClaudeSession {
  controlSessionId:string;
  source:"paperclip_owned_interactive";
  identity:{nativeSessionId:string;processGeneration:string;sessionBinding:"verified"|"provisional";remoteControl:"requested_connection_unverified";hook:{event:"SessionStart";peer:string;namespace:string}};
  capabilities:{managedTurns:"unsupported";settlement:"unsupported";remoteControlPairing:"unverified";tools:"disabled"|"scoped_admitted_run"};
  settlement?:{state:"unproven";reason:string};
}

function managedPath(companyId:string, controlId?:string) {
  const base=`/companies/${encodeURIComponent(companyId)}/native-sessions/claude/managed`;
  return controlId ? `${base}/${encodeURIComponent(controlId)}` : base;
}

export const nativeClaudeSessionsApi = {
  list: (companyId: string) => api.get<NativeClaudeSessionsResponse>(
    `/companies/${encodeURIComponent(companyId)}/native-sessions/claude`,
  ),
  launch:(companyId:string,workspaceId:string,requestId:string,runId?:string)=>api.post<ManagedClaudeSession>(managedPath(companyId),{workspaceId,requestId,...(runId?{runId}:{})}),
  read:(companyId:string,id:string)=>api.get<ManagedClaudeSession>(managedPath(companyId,id)),
  input:(companyId:string,id:string,operationId:string,text:string)=>api.post<{write:"attempted";delivery:"unknown"}>(`${managedPath(companyId,id)}/input`,{operationId,text}),
  interrupt:(companyId:string,id:string,operationId:string)=>api.post<{interrupt:"attempted";settlement:"unproven"}>(`${managedPath(companyId,id)}/interrupt`,{operationId}),
  detach:(companyId:string,id:string)=>api.post<{detached:true;ownerProcess:"retained"}>(`${managedPath(companyId,id)}/detach`,{}),
};
