import { api } from "./client";

export type ExternalActivity = {
  stableExternalId: string;
  kind: "external_opencode_activity";
  authority: "observer_only";
  modelLabel: string;
  backend: string;
  status: "observed_active" | "handoff" | "idle" | "stale" | "unverified";
  backendVerified: boolean;
  currentSessionId: string;
  sessionLineage: string[];
  committedHandoffCount: number;
  handoffLimitReached: boolean;
  guardPhase: string;
  lastNativeEventAt: string;
  observedAt: string;
  paperclipRunId: null;
  paperclipAgentId: null;
  paperclipTaskCheckout: false;
  claim: "advisory_presence_not_managed_execution";
};

export const externalActivityApi = {
  list: (companyId: string) =>
    api.get<ExternalActivity[]>(`/companies/${encodeURIComponent(companyId)}/external-activity`),
};
