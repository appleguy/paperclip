import { useQuery } from "@tanstack/react-query";
import { nativeClaudeSessionsApi } from "../api/nativeClaudeSessions";
import { useCompany } from "../context/CompanyContext";
import { Button } from "../components/ui/button";

export function NativeClaudeSessions() {
  const { selectedCompanyId } = useCompany();
  const sessions = useQuery({
    queryKey: ["native-claude-sessions", selectedCompanyId],
    queryFn: () => nativeClaudeSessionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Claude sessions</h1>
          <p className="text-sm text-muted-foreground">Observed external sessions on this host. These are not linked to a Paperclip run.</p>
        </div>
        <Button variant="outline" onClick={() => void sessions.refetch()} disabled={!selectedCompanyId || sessions.isFetching}>
          {sessions.isFetching ? "Checking…" : "Refresh"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">This is a snapshot of processes observed when checked, not a live feed. Remote Control pairing is unknown. You can continue steering in Claude’s native interface; this observer does not control sessions.</p>
      {!selectedCompanyId && <p>Select a company to view sessions.</p>}
      {selectedCompanyId && sessions.isPending && <p role="status">Checking for sessions…</p>}
      {selectedCompanyId && sessions.isError && <p role="alert" className="text-destructive">Could not check sessions. This view requires an authenticated instance administrator with access to the selected company.</p>}
      {sessions.data && !sessions.isError && (
        <section aria-label="Observed Claude sessions" className="space-y-3">
          {sessions.data.sessions.length === 0 && <p>No sessions were observed at the last check.</p>}
          {sessions.data.sessions.map((session) => (
            <article key={session.sessionId} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Observed external</span>
                <span className="text-muted-foreground">{session.kind} · {session.status} at check</span>
              </div>
              <div className="text-sm"><span className="text-muted-foreground">Session ID: </span><span className="break-all font-mono">{session.sessionId}</span></div>
              <p className="text-sm text-muted-foreground">Remote Control pairing: unknown</p>
            </article>
          ))}
          {sessions.data.truncated && <p className="text-sm text-muted-foreground">Results were limited; more sessions may exist.</p>}
        </section>
      )}
    </main>
  );
}
