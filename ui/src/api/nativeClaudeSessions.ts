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

export const nativeClaudeSessionsApi = {
  list: (companyId: string) => api.get<NativeClaudeSessionsResponse>(
    `/companies/${encodeURIComponent(companyId)}/native-sessions/claude`,
  ),
};
