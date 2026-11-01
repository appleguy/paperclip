// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { nativeClaudeSessionsApi } from "../api/nativeClaudeSessions";
import { NativeClaudeSessions } from "./NativeClaudeSessions";

const state = vi.hoisted(() => ({ companyId: "company-one" as string | null }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../api/nativeClaudeSessions", () => ({ nativeClaudeSessionsApi: { list: vi.fn() } }));

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
