// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { nativeClaudeSessionsApi } from "../api/nativeClaudeSessions";
import { NativeClaudeSessions } from "./NativeClaudeSessions";
import { projectsApi } from "../api/projects";

const state = vi.hoisted(() => ({ companyId: "company-one" as string | null }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../api/nativeClaudeSessions", () => ({ nativeClaudeSessionsApi: { list: vi.fn(),launch:vi.fn(),read:vi.fn(),input:vi.fn(),interrupt:vi.fn(),detach:vi.fn() } }));
vi.mock("../api/projects",()=>({projectsApi:{list:vi.fn(async()=>[{id:"project",name:"Project"}]),listWorkspaces:vi.fn(async()=>[{id:"workspace",name:"Workspace",cwd:"/workspace"}])}}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => flushSync(() => root.render(<QueryClientProvider client={client}><NativeClaudeSessions /></QueryClientProvider>));
  render();
  return { container, render, cleanup: () => { flushSync(() => root.unmount()); container.remove(); client.clear(); } };
}

it("shows an external snapshot without claiming RC pairing and refreshes on request", async () => {
  state.companyId = "company-one";
  vi.mocked(nativeClaudeSessionsApi.list).mockReset().mockResolvedValue({ sessions: [{ sessionId: "exact-session-id", source: "observed_external", kind: "interactive", status: "running", remoteControl: "unknown", ownerIntervention: "vendor_native_unverified" }], truncated: true });
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("exact-session-id"));
    expect(page.container.textContent).toContain("Observed external");
    expect(page.container.textContent).toContain("running at check");
    expect(page.container.textContent).toContain("Remote Control pairing: unknown");
    expect(page.container.textContent).toContain("more sessions may exist");
    expect(page.container.querySelector("a")).toBeNull();
    const button = page.container.querySelector("button")!;
    flushSync(() => button.click());
    await vi.waitFor(() => expect(nativeClaudeSessionsApi.list).toHaveBeenCalledTimes(2));
    expect(nativeClaudeSessionsApi.list).toHaveBeenCalledWith("company-one");
  } finally { page.cleanup(); }
});

it("launches an owned workspace session and treats failed input as uncertain without retry",async()=>{
  state.companyId="company-one";
  vi.mocked(nativeClaudeSessionsApi.list).mockReset().mockResolvedValue({sessions:[],truncated:false});
  vi.mocked(nativeClaudeSessionsApi.launch).mockReset().mockResolvedValue({controlSessionId:"control",source:"paperclip_owned_interactive",identity:{nativeSessionId:"native-id",processGeneration:"pid:birth",sessionBinding:"provisional",remoteControl:"requested_connection_unverified",hook:{event:"SessionStart",peer:"kernel",namespace:"parent"}},capabilities:{managedTurns:"unsupported",settlement:"unsupported",remoteControlPairing:"unverified",tools:"disabled"}});
  vi.mocked(nativeClaudeSessionsApi.input).mockReset().mockRejectedValue(new Error("lost response"));
  vi.mocked(nativeClaudeSessionsApi.interrupt).mockReset().mockResolvedValue({interrupt:"attempted",settlement:"unproven"});
  vi.mocked(nativeClaudeSessionsApi.detach).mockReset().mockResolvedValue({detached:true,ownerProcess:"retained"});
  const page=setup();
  try {
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[0]?.options.length).toBe(2));
    const project=page.container.querySelectorAll("select")[0]!;flushSync(()=>{project.value="project";project.dispatchEvent(new Event("change",{bubbles:true}));});
    await vi.waitFor(()=>expect(projectsApi.listWorkspaces).toHaveBeenCalledWith("project","company-one"));
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[1]?.options.length).toBe(2));
    const workspace=page.container.querySelectorAll("select")[1]!;flushSync(()=>{workspace.value="workspace";workspace.dispatchEvent(new Event("change",{bubbles:true}));});
    const button=(label:string)=>Array.from(page.container.querySelectorAll("button")).find(item=>item.textContent===label)!;
    flushSync(()=>button("Launch").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("native-id"));
    expect(nativeClaudeSessionsApi.launch).toHaveBeenCalledWith("company-one","workspace",expect.any(String));expect(page.container.textContent).toContain("Settlement: unproven");expect(page.container.querySelector("a")).toBeNull();
    flushSync(()=>button("Attempt Ctrl-C").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("interruption and settlement are unknown"));expect(nativeClaudeSessionsApi.interrupt).toHaveBeenCalledWith("company-one","control",expect.any(String));
    const textarea=page.container.querySelector("textarea")!;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
    flushSync(()=>{setter.call(textarea,"hello");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    flushSync(()=>button("Send input").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("New owner input remains available"));
    expect(button("Send input").disabled).toBe(false);expect(button("Attempt Ctrl-C").disabled).toBe(false);expect(nativeClaudeSessionsApi.input).toHaveBeenCalledTimes(1);
    flushSync(()=>button("Detach").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("owner process remains running"));expect(nativeClaudeSessionsApi.detach).toHaveBeenCalledOnce();
  } finally {page.cleanup();}
});

it("passes an optional admitted run id and shows scoped tools",async()=>{
  state.companyId="company-one";
  vi.mocked(nativeClaudeSessionsApi.list).mockReset().mockResolvedValue({sessions:[],truncated:false});
  vi.mocked(nativeClaudeSessionsApi.launch).mockReset().mockResolvedValue({controlSessionId:"control",source:"paperclip_owned_interactive",identity:{nativeSessionId:"native-id",processGeneration:"pid:birth",sessionBinding:"verified",remoteControl:"requested_connection_unverified",hook:{event:"SessionStart",peer:"kernel",namespace:"parent"}},capabilities:{managedTurns:"unsupported",settlement:"unsupported",remoteControlPairing:"unverified",tools:"scoped_admitted_run"}});
  const page=setup();
  try {
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[0]?.options.length).toBe(2));
    const project=page.container.querySelectorAll("select")[0]!;flushSync(()=>{project.value="project";project.dispatchEvent(new Event("change",{bubbles:true}));});
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[1]?.options.length).toBe(2));
    const workspace=page.container.querySelectorAll("select")[1]!;flushSync(()=>{workspace.value="workspace";workspace.dispatchEvent(new Event("change",{bubbles:true}));});
    const input=page.container.querySelector("input")!;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
    flushSync(()=>{setter.call(input," run-1 ");input.dispatchEvent(new Event("input",{bubbles:true}));});
    const launch=Array.from(page.container.querySelectorAll("button")).find(item=>item.textContent==="Launch")!;
    flushSync(()=>launch.click());await vi.waitFor(()=>expect(page.container.textContent).toContain("native-id"));
    expect(nativeClaudeSessionsApi.launch).toHaveBeenCalledWith("company-one","workspace",expect.any(String),"run-1");
    expect(page.container.textContent).toContain("scoped to the admitted run");
    expect(page.container.textContent).toContain("no native turn identity");
  } finally {page.cleanup();}
});
it("reconciles a lost launch response using the same request without launching again",async()=>{
  state.companyId="company-one";
  vi.mocked(nativeClaudeSessionsApi.list).mockReset().mockResolvedValue({sessions:[],truncated:false});
  vi.mocked(nativeClaudeSessionsApi.launch).mockReset().mockRejectedValue(new Error("lost response"));
  vi.mocked(nativeClaudeSessionsApi.read).mockReset().mockRejectedValue(new Error("not confirmed"));
  const page=setup();
  try {
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[0]?.options.length).toBe(2));
    const project=page.container.querySelectorAll("select")[0]!;flushSync(()=>{project.value="project";project.dispatchEvent(new Event("change",{bubbles:true}));});
    await vi.waitFor(()=>expect(page.container.querySelectorAll("select")[1]?.options.length).toBe(2));
    const workspace=page.container.querySelectorAll("select")[1]!;flushSync(()=>{workspace.value="workspace";workspace.dispatchEvent(new Event("change",{bubbles:true}));});
    const button=(label:string)=>Array.from(page.container.querySelectorAll("button")).find(item=>item.textContent===label)!;
    flushSync(()=>button("Launch").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("Launch outcome is unknown"));
    const requestId=vi.mocked(nativeClaudeSessionsApi.launch).mock.calls[0]![2];expect(page.container.textContent).toContain(requestId);
    flushSync(()=>button("Check launch").click());await vi.waitFor(()=>expect(page.container.textContent).toContain("Could not confirm"));
    expect(nativeClaudeSessionsApi.read).toHaveBeenCalledWith("company-one",requestId);expect(nativeClaudeSessionsApi.launch).toHaveBeenCalledTimes(1);
    expect(Array.from(page.container.querySelectorAll("button")).some(item=>item.textContent==="Launch")).toBe(false);
  } finally {page.cleanup();}
});

it("does not display a previous company's sessions when the selected company changes", async () => {
  state.companyId = "company-one";
  vi.mocked(nativeClaudeSessionsApi.list).mockReset().mockResolvedValueOnce({ sessions: [{ sessionId: "private-session", source: "observed_external", kind: "interactive", status: "idle", remoteControl: "unknown", ownerIntervention: "vendor_native_unverified" }], truncated: false }).mockRejectedValueOnce(new Error("denied"));
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("private-session"));
    state.companyId = "company-two";
    page.render();
    await vi.waitFor(() => expect(page.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.container.textContent).not.toContain("private-session");
    expect(nativeClaudeSessionsApi.list).toHaveBeenCalledWith("company-two");
  } finally { page.cleanup(); }
});
