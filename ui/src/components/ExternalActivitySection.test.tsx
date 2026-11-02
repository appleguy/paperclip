// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalActivitySection, externalActivityLabel } from "./ExternalActivitySection";

const list = vi.hoisted(() => vi.fn());
vi.mock("../api/externalActivity", () => ({ externalActivityApi: { list } }));
vi.mock("./SidebarSection", () => ({
  SidebarSection: ({label,children}: {label:string;children:ReactNode}) =>
    <section aria-label={label}>{children}</section>,
}));

let node: HTMLDivElement;
let root: Root;
let client: QueryClient;
const activity = {
  stableExternalId:"external/mac-pro/ztop/maya-l-medium",
  kind:"external_opencode_activity",
  authority:"observer_only",
  modelLabel:"GLM-5.3 Flash · Maya-L Medium",
  backend:"OpenCode v2.2.2",
  status:"observed_active",
  currentSessionId:"ses_e6b819e5bffeNhTG19TKi4gE3m",
  committedHandoffCount:3,
  handoffLimitReached:true,
  paperclipRunId:null,
  paperclipAgentId:null,
  paperclipTaskCheckout:false,
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  list.mockReset();
  list.mockResolvedValue([]);
  client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  node=document.createElement("div");
  document.body.appendChild(node);
  root=createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  node.remove();
});

async function render(companyId: string | null) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>
      <ExternalActivitySection companyId={companyId} />
    </QueryClientProvider>);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("ExternalActivitySection", () => {
  it("hides itself when disabled or no observer is configured", async () => {
    await render(null);
    expect(node.textContent).toBe("");
    expect(list).not.toHaveBeenCalled();
    await render("company");
    expect(node.textContent).toBe("");
  });
  it("renders advisory presence without inventing a managed run", async () => {
    list.mockResolvedValue([activity]);
    client.setQueryData(["external-opencode-activity", "company"], [activity]);
    await render("company");
    expect(node.querySelector('section[aria-label="External activity"]')).not.toBeNull();
    expect(node.textContent).toContain("GLM Maya-L · Ztop");
    expect(node.textContent).toContain("Observed live");
    expect(node.textContent).toContain("Observed, not managed");
    expect(node.textContent).toContain("3 verified handoffs");
    expect(node.textContent).toContain("Limit reached");
    expect(node.querySelector('[data-testid="external-activity-row"]')).not.toBeNull();
    expect(node.querySelector('a[href*="heartbeat"]')).toBeNull();
  });
  it("does not confuse native idle state with active generation", async () => {
    list.mockResolvedValue([{...activity,status:"idle"}]);
    client.setQueryData(["external-opencode-activity", "company"], [{...activity,status:"idle"}]);
    await render("company");
    expect(node.textContent).toContain("Idle");
    expect(node.textContent).not.toContain("Observed live");
  });
  it("provides distinct status labels", () => {
    expect(externalActivityLabel("handoff")).toBe("Session handoff");
    expect(externalActivityLabel("stale")).toBe("Stale observation");
    expect(externalActivityLabel("unverified")).toBe("Not verified");
  });
});
