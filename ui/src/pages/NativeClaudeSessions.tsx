import { useQuery } from "@tanstack/react-query";
import { nativeClaudeSessionsApi } from "../api/nativeClaudeSessions";
import { useCompany } from "../context/CompanyContext";
import { Button } from "../components/ui/button";
import { useRef, useState } from "react";
import { projectsApi } from "../api/projects";
import type { ManagedClaudeSession } from "../api/nativeClaudeSessions";

function operationId():string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function ManagedClaudeControl({companyId}:{companyId:string}) {
  const [projectId,setProjectId]=useState("");
  const [workspaceId,setWorkspaceId]=useState("");
  const [runId,setRunId]=useState("");
  const [pendingId,setPendingId]=useState<string | null>(null);
  const [session,setSession]=useState<ManagedClaudeSession | null>(null);
  const [message,setMessage]=useState("");
  const [text,setText]=useState("");
  const [busy,setBusy]=useState(false);
  const flight=useRef(false);
  const projects=useQuery({queryKey:["claude-managed-projects",companyId],queryFn:()=>projectsApi.list(companyId),retry:false});
  const workspaces=useQuery({queryKey:["claude-managed-workspaces",companyId,projectId],queryFn:()=>projectsApi.listWorkspaces(projectId,companyId),enabled:!!projectId,retry:false});
  async function run(work:()=>Promise<void>) {if(flight.current)return;flight.current=true;setBusy(true);try{await work();}finally{flight.current=false;setBusy(false);}}
  async function launch() {
    if(flight.current || !workspaceId || pendingId || session)return;
    const requestId=operationId();setPendingId(requestId);setMessage("");
    await run(async()=>{try{setSession(await (runId.trim()?nativeClaudeSessionsApi.launch(companyId,workspaceId,requestId,runId.trim()):nativeClaudeSessionsApi.launch(companyId,workspaceId,requestId)));setPendingId(null);}catch{setMessage("Launch outcome is unknown. Check this request before attempting another launch.");}});
  }
  async function check() {
    const id=session?.controlSessionId ?? pendingId;if(!id)return;
    await run(async()=>{try{setSession(await nativeClaudeSessionsApi.read(companyId,id));setPendingId(null);setMessage("");}catch{setMessage("Could not confirm this control session. Its owner process may still be running.");}});
  }
  async function send(kind:"input"|"interrupt") {
    if(!session||(kind==="input"&&!text.trim()))return;
    const id=session.controlSessionId,writeId=operationId(),payload=text;
    await run(async()=>{try{
      if(kind==="input"){await nativeClaudeSessionsApi.input(companyId,id,writeId,`${payload}\r`);setText("");setMessage("Input write attempted; delivery and completion are unknown.");}
      else {await nativeClaudeSessionsApi.interrupt(companyId,id,writeId);setMessage("Ctrl-C write attempted; interruption and settlement are unknown.");}
    }catch{setMessage("The previous write outcome is unknown. New owner input remains available; check before deliberately repeating that input.");}});
  }
  async function detach() {
    if(!session)return;const id=session.controlSessionId;
    await run(async()=>{try{await nativeClaudeSessionsApi.detach(companyId,id);setSession(null);setMessage("Detached. The owner process remains running and cannot be reattached here.");}catch{setMessage("Detach outcome is unknown. The owner process may still be running.");}});
  }
  return <section aria-label="Owned interactive Claude" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h2 className="text-lg font-semibold">Owned interactive Claude</h2>
    <p className="text-sm text-muted-foreground">Launch a new owner-controlled session in a company workspace. Tools are disabled unless you bind an admitted Paperclip run below; the server must confirm that run and its live lease. Owner input always stays available. This is not a Paperclip managed task completion path; Remote Control pairing and turn settlement are unverified.</p>
    {!session && !pendingId && <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Project<select className="rounded border bg-background p-2" value={projectId} onChange={event=>{setProjectId(event.target.value);setWorkspaceId("");}}><option value="">Select project</option>{projects.data?.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Workspace<select className="rounded border bg-background p-2" value={workspaceId} onChange={event=>setWorkspaceId(event.target.value)} disabled={!projectId || workspaces.isPending}><option value="">Select workspace</option>{workspaces.data?.filter(workspace=>!!workspace.cwd).map(workspace=><option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Admitted run ID (optional)<input className="rounded border bg-background p-2 font-mono" value={runId} onChange={event=>setRunId(event.target.value)} placeholder="Run UUID" /></label>
      <Button onClick={()=>void launch()} disabled={!workspaceId||busy}>Launch</Button>
    </div>}
    {(projects.isError || (projectId && workspaces.isError)) && <p role="alert" className="text-sm text-destructive">Could not load company projects or workspaces.</p>}
    {pendingId && <div className="space-y-2"><p className="text-sm">Launch request: <span className="break-all font-mono">{pendingId}</span></p><Button variant="outline" disabled={busy} onClick={()=>void check()}>Check launch</Button></div>}
    {session && <div className="space-y-3">
      <p className="text-sm">Native session ID: <span className="break-all font-mono">{session.identity.nativeSessionId}</span></p>
      <p className="text-sm">Control session ID: <span className="break-all font-mono">{session.controlSessionId}</span></p>
      <p className="text-sm text-muted-foreground">Identity: {session.identity.sessionBinding}. Tools: {session.capabilities.tools==="scoped_admitted_run"?"scoped to the admitted run (calls carry no native turn identity)":"disabled"}. Remote Control pairing: unknown. Settlement: unproven.</p>
      <p className="text-sm text-muted-foreground">This page cannot reconnect after refresh or detach. Detaching leaves the owner process running.</p>
      <label className="flex flex-col gap-1 text-sm">Owner input<textarea className="min-h-24 rounded border bg-background p-2" value={text} onChange={event=>setText(event.target.value)} disabled={busy} /></label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy||!text.trim()} onClick={()=>void send("input")}>Send input</Button><Button variant="outline" disabled={busy} onClick={()=>void send("interrupt")}>Attempt Ctrl-C</Button><Button variant="outline" disabled={busy} onClick={()=>void check()}>Check status</Button><Button variant="outline" disabled={busy} onClick={()=>void detach()}>Detach</Button></div>
    </div>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}

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
      <p className="text-sm text-muted-foreground">Observed external sessions are a snapshot, not a live feed. Remote Control pairing is unknown; these sessions cannot be controlled from this view.</p>
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
      {selectedCompanyId && <ManagedClaudeControl key={selectedCompanyId} companyId={selectedCompanyId} />}
    </main>
  );
}
