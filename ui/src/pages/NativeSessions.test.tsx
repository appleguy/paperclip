// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { nativeSessionsApi } from "../api/nativeSessions";
import { NativeSessions } from "./NativeSessions";
const state=vi.hoisted(()=>({companyId:"company-one" as string|null}));
vi.mock("../context/CompanyContext",()=>({useCompany:()=>({selectedCompanyId:state.companyId})}));
vi.mock("../api/nativeSessions",()=>({nativeSessionsApi:{list:vi.fn()}}));
vi.mock("@/lib/router",()=>({Link:({to,children,...props}:any)=><a href={to} {...props}>{children}</a>}));
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const container=document.createElement("div");document.body.appendChild(container);const root=createRoot(container);flushSync(()=>root.render(<QueryClientProvider client={client}><NativeSessions/></QueryClientProvider>));return{container,cleanup:()=>{flushSync(()=>root.unmount());container.remove();client.clear()}};}
it("shows bounded persisted identity, exact run link and unverified control",async()=>{
 vi.mocked(nativeSessionsApi.list).mockResolvedValue({sessions:[{source:"paperclip_persisted_run",companyId:"company-one",runId:"run",agentId:"agent",issueId:null,driverKind:"codex_app_server",normalizedSessionId:"paperclip-id",providerSessionId:"provider-id",providerSessionIdSource:"run.sessionIdAfter",taskSessionId:null,runStatus:"running",state:"unknown",stateEvidence:"insufficient_evidence",goal:null,lastOutputAt:null,capabilities:{nativeLink:null,nativeControl:"unknown",managedSteering:"unknown"}}]});
 const page=setup();try{await vi.waitFor(()=>expect(page.container.textContent).toContain("provider-id"));expect(nativeSessionsApi.list).toHaveBeenCalledWith("company-one");expect(page.container.textContent).toContain("not proof of a live connection");expect(page.container.textContent).toContain("Native controls unavailable");expect(page.container.querySelector('a[href="/agents/agent/runs/run"]')).not.toBeNull();expect(page.container.querySelectorAll("button")).toHaveLength(1);}finally{page.cleanup()}
});
it("does not query without a company",()=>{state.companyId=null;vi.mocked(nativeSessionsApi.list).mockClear();const page=setup();try{expect(page.container.textContent).toContain("Select a company");expect(nativeSessionsApi.list).not.toHaveBeenCalled();}finally{page.cleanup();state.companyId="company-one"}});
it("distinguishes a failed terminal run from task outcome",async()=>{
 vi.mocked(nativeSessionsApi.list).mockResolvedValue({sessions:[{source:"paperclip_persisted_run",companyId:"company-one",runId:"failed-run",agentId:"agent",issueId:null,driverKind:"codex_app_server",normalizedSessionId:null,providerSessionId:"native",providerSessionIdSource:"run.sessionIdAfter",taskSessionId:null,runStatus:"failed",state:"run-terminal",stateEvidence:"persisted_terminal_run",goal:null,lastOutputAt:null,capabilities:{nativeLink:null,nativeControl:"unknown",managedSteering:"unknown"}}]});
 const page=setup();try{await vi.waitFor(()=>expect(page.container.textContent).toContain("Run ended with status failed"));expect(page.container.textContent).toContain("does not establish the task outcome");}finally{page.cleanup()}
});
