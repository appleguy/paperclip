import { useQuery } from "@tanstack/react-query";
import { Activity, GitBranch, CircleDot } from "lucide-react";
import { externalActivityApi, type ExternalActivity } from "../api/externalActivity";
import { SidebarSection } from "./SidebarSection";

export function externalActivityLabel(status: ExternalActivity["status"]): string {
  switch (status) {
    case "observed_active": return "Observed live";
    case "handoff": return "Session handoff";
    case "idle": return "Idle";
    case "stale": return "Stale observation";
    case "unverified": return "Not verified";
  }
}

/**
 * External activity is NOT a managed agent and has no heartbeat/run authority.
 * Keep it outside the Agents list and never add it to liveRun counts.
 */
export function ExternalActivitySection({ companyId }: { companyId: string | null }) {
  const query = useQuery({
    queryKey: ["external-opencode-activity", companyId],
    queryFn: () => externalActivityApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 15_000,
    retry: false,
    // Only sample while this sidebar is mounted AND the server has advertised
    // a configured observer. No permanent server-side scan or idle timer.
    refetchInterval: (q) => q.state.data?.length ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
  const items = query.data ?? [];
  if (items.length === 0) return null;

  return (
    <SidebarSection label="External activity">
      {items.map((activity) => (
        <div
          key={activity.stableExternalId}
          data-testid="external-activity-row"
          className="mx-2 my-1 rounded-lg border border-sidebar-border/60 px-2.5 py-2"
          title={`External observer only. Native session: ${activity.currentSessionId}`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Activity aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-(length:--text-compact) font-medium">
              GLM Maya-L · Ztop
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <CircleDot aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>{externalActivityLabel(activity.status)}</span>
            <span className="ml-auto">Observed, not managed</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>{activity.committedHandoffCount} verified handoffs</span>
            {activity.handoffLimitReached ? (
              <span className="ml-auto" title="The Ztop guard has reached its current handoff ceiling">
                Limit reached
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </SidebarSection>
  );
}
