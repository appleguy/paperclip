import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Button } from "../components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { nativeSessionsApi } from "../api/nativeSessions";

export function NativeSessions() {
  const {selectedCompanyId}=useCompany();
  const query=useQuery({queryKey:["native-sessions",selectedCompanyId],queryFn:()=>nativeSessionsApi.list(selectedCompanyId!),enabled:!!selectedCompanyId,retry:false,refetchOnWindowFocus:false});
  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="space-y-2"><h1 className="text-2xl font-semibold">Native sessions</h1><p className="text-sm text-muted-foreground">Paperclip run records for this company. Session identities and goal states are persisted observations, not proof of a live connection.</p></div><Button variant="outline" onClick={()=>void query.refetch()} disabled={!selectedCompanyId||query.isFetching}>{query.isFetching?"Checking…":"Refresh"}</Button></div>
    <p className="text-sm text-muted-foreground">The list is limited and filtered by your access. Native control and Remote Control pairing are unverified. <Link className="underline" to="/native-sessions/claude">View observed Claude sessions</Link></p>
    {!selectedCompanyId&&<p>Select a company to view sessions.</p>}
    {selectedCompanyId&&query.isPending&&<p role="status">Loading sessions…</p>}
    {selectedCompanyId&&query.isError&&<p role="alert" className="text-destructive">Could not load sessions for this company.</p>}
    {query.data&&<section aria-label="Persisted native sessions" className="space-y-3">{query.data.sessions.length===0&&<p>No accessible sessions in this snapshot.</p>}{query.data.sessions.map((session)=><article key={session.runId} className="min-w-0 space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{session.driverKind??"Provider unknown"}</h2><span className="text-sm">{session.state} <span className="text-muted-foreground">({session.stateEvidence.replaceAll("_"," ")})</span></span></div>
      {session.state === "run-terminal" && <p className="text-sm text-muted-foreground">Run ended with status {session.runStatus}. This does not establish the task outcome.</p>}
      <p className="break-all text-sm">Run: <Link className="underline" to={`/agents/${encodeURIComponent(session.agentId)}/runs/${encodeURIComponent(session.runId)}`}>{session.runId}</Link></p>
      <p className="break-all text-sm">Native provider session: {session.providerSessionId??"Unknown"}</p>
      {session.normalizedSessionId&&<p className="break-all text-sm">Paperclip session: {session.normalizedSessionId}</p>}
      {session.goal&&<p className="text-sm">Goal observed {session.goal.status} at {session.goal.observedAt}; current status is unverified.</p>}
      <p className="text-sm text-muted-foreground">Native controls unavailable here: session authority and pairing have not been verified.</p>
    </article>)}</section>}
  </main>;
}
