import { describe, expect, it, vi } from "vitest";
import { createOpenCodeSharedObserver } from "./opencode-shared-observer.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";

const commit = vi.hoisted(() => vi.fn());
vi.mock("./opencode-shared-authority.js", () => ({ commitOpenCodeSharedLog: commit }));
const binding: OpenCodeSharedBinding = { companyId: "company", projectId: "project", issueId: "issue", agentId: "agent", runId: "run", taskSessionId: "task", normalizedSessionId: "native", runnerInstanceId: "runner", providerSessionId: "ses_test", generation: "generation", epoch: "epoch", version: "2.2.5", model: "model", effort: "high", leaseOwner: "lease", leaseAttempt: 1, controllerBootId: "boot", controllerPid: 1, controllerProcessStartedAt: new Date(1), controllerGeneration: 1 };
const event = { id: "evt_1", type: "session.started", data: { sessionID: "ses_test" }, durable: { aggregateID: "ses_test", seq: 1, version: 1 } };
function fixture() {
  const sessionParamsJson = { opencodeSharedV2: { ...binding, cursor: null } };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ sessionParamsJson }] }) }) }) };
  const attest = vi.fn(async () => {});
  const fetch = vi.fn(async (url: string | URL | Request) => String(url).includes("/experimental/")
    ? new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_test", seq: 1 })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    : Response.json({ data: { id: "ses_test" } }));
  const observer = createOpenCodeSharedObserver(db as never, { binding, admission: { baseUrl: "http://127.0.0.1:1234", authorization: "Bearer fixture", attest }, fetch: fetch as typeof globalThis.fetch });
  return { observer, attest, fetch, sessionParamsJson };
}
describe("OpenCode shared observer", () => {
  it("verifies the session and forwards durable events through the lease-backed writer", async () => {
    commit.mockReset(); const f = fixture();
    await expect(f.observer.observe()).rejects.toThrow("disconnected");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]![2]).toEqual({ previous: null, next: 1, item: event });
    expect(f.attest).toHaveBeenCalledTimes(5);
  });
  it("rejects a foreign persisted generation before opening the log", async () => {
    commit.mockReset(); const f = fixture(); f.sessionParamsJson.opencodeSharedV2.generation = "foreign";
    await expect(f.observer.observe()).rejects.toThrow("identity_mismatch");
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled();
  });
  it("stops before network access if host attestation fails", async () => {
    const f = fixture(); f.attest.mockRejectedValueOnce(new Error("stale daemon"));
    await expect(f.observer.observe()).rejects.toThrow("stale daemon"); expect(f.fetch).not.toHaveBeenCalled();
  });
});
