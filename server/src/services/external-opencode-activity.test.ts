import { describe, expect, it } from "vitest";
import { listExternalOpenCodeActivity, parseExternalActivity } from "./external-opencode-activity.js";

const company = "55cef09f-ec08-4e71-8e7f-2afb4a912ce8";
const other = "00000000-0000-4000-8000-000000000000";
const base = {
  stableExternalId: "external/mac-pro/ztop/maya-l-medium",
  kind: "external_opencode_activity",
  authority: "observer_only",
  modelLabel: "GLM-5.3 Flash · Maya-L Medium",
  backend: "OpenCode v2.2.2",
  status: "observed_active",
  backendVerified: true,
  currentSessionId: "ses_e6b819e5bffeNhTG19TKi4gE3m",
  sessionLineage: ["ses_e6bdf8d37ffef6gbWoeczcwZci", "ses_e6b819e5bffeNhTG19TKi4gE3m"],
  committedHandoffCount: 1,
  handoffLimitReached: false,
  guardPhase: "watch",
  lastNativeEventAt: "2026-10-31T18:00:00.000Z",
  observedAt: "2026-10-31T18:00:01.000Z",
  paperclipRunId: null,
  paperclipAgentId: null,
  paperclipTaskCheckout: false,
  claim: "advisory_presence_not_managed_execution",
};

describe("external OpenCode activity source-scoping and authority", () => {
  it("returns nothing when not enabled, and never launches the observer", async () => {
    let invoked = 0;
    const result = await listExternalOpenCodeActivity(company, {
      configuredCompanyId: "", runner: async () => { invoked++; return JSON.stringify(base); },
    });
    expect(result).toEqual([]);
    expect(invoked).toBe(0);
  });
  it("prevents cross-company lookup before any file or process read", async () => {
    let invoked = 0;
    const result = await listExternalOpenCodeActivity(other, {
      configuredCompanyId: company, runner: async () => { invoked++; return JSON.stringify(base); },
    });
    expect(result).toEqual([]);
    expect(invoked).toBe(0);
  });
  it("accepts exact observer contract without a managed run", async () => {
    const result = await listExternalOpenCodeActivity(company, {
      configuredCompanyId: company, runner: async () => JSON.stringify(base),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "external_opencode_activity", authority: "observer_only",
      status: "observed_active", paperclipRunId: null, paperclipAgentId: null,
      paperclipTaskCheckout: false, committedHandoffCount: 1,
    });
  });
  it("rejects fake Paperclip runs or invented agent ownership", () => {
    for (const input of [
      { ...base, paperclipRunId: "fake" },
      { ...base, paperclipAgentId: "fake" },
      { ...base, paperclipTaskCheckout: true },
      { ...base, authority: "writer" },
    ]) expect(parseExternalActivity(JSON.stringify(input))).toBeNull();
  });
  it("rejects an unrelated tab or mismatched lineage", () => {
    expect(parseExternalActivity(JSON.stringify({ ...base, currentSessionId: "ses_foreign0123456789" }))).toBeNull();
    expect(parseExternalActivity(JSON.stringify({ ...base, committedHandoffCount: 99 }))).toBeNull();
    expect(parseExternalActivity("{bad-json")).toBeNull();
  });
  it("fails closed when the observer process errors", async () => {
    const result = await listExternalOpenCodeActivity(company, {
      configuredCompanyId: company, runner: async () => { throw new Error("offline"); },
    });
    expect(result).toEqual([]);
  });
  it("keeps idle and unverified distinct from active", () => {
    for (const status of ["idle", "unverified", "stale", "handoff"]) {
      expect(parseExternalActivity(JSON.stringify({ ...base, status }))?.status).toBe(status);
    }
  });
});
