import { expect, it, vi } from "vitest";
import { inspectHeldOpenCodeRun } from "./opencode-held-turn-inspection.js";

function fixture() {
  const run = { id: "run", companyId: "company", agentId: "agent", issueId: "issue", status: "running",
    runtimeMode: "legacy", errorCode: null, controllerBootId: "boot", controllerLeaseExpiresAt: new Date(1000),
    contextSnapshot: { issueId: "issue" }, resultJson: { earlySession: { sessionId: "ses", sessionParams: { cwd: "/work" } } } };
  const agent = { id: "agent", companyId: "company", adapterType: "opencode_local",
    adapterConfig: { nativeRuntime: "nar", sharedServerRecoveryConfigPath: "/config" } };
  let latestRun = structuredClone(run), latestAgent = structuredClone(agent);
  const inspect = vi.fn(async () => ({ state: "observed_idle" as const, reason: "target_idle_at_observation" }));
  const input = { run: run as never, agent: agent as never, now: () => 2000,
    loadRun: async () => latestRun as never, loadAgent: async () => latestAgent as never, inspect };
  return { run, agent, input, inspect,
    setRun: (patch: Partial<typeof run>) => { latestRun = { ...latestRun, ...patch }; },
    setAgent: (patch: Partial<typeof agent>) => { latestAgent = { ...latestAgent, ...patch }; } };
}

it("returns an observation only while the exact run binding and expired controller remain unchanged", async () => {
  const f = fixture();
  expect(await inspectHeldOpenCodeRun(f.input)).toEqual({ state: "observed_idle", reason: "target_idle_at_observation" });
  expect(f.inspect).toHaveBeenCalledOnce();
  expect(f.inspect).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", agentId: "agent", taskId: "issue", cwd: "/work", configPath: "/config" }));
});

it.each([null, new Date(3000)])("never contacts the provider for an unknown or live controller lease: %s", async expires => {
  const f = fixture();
  f.run.controllerLeaseExpiresAt = expires as Date;
  expect(await inspectHeldOpenCodeRun(f.input)).toMatchObject({ state: "unverified", reason: "controller_not_expired_or_unknown" });
  expect(f.inspect).not.toHaveBeenCalled();
});

it("discards an observation when controller ownership, run status or binding changes during inspection", async () => {
  for (const patch of [
    { controllerBootId: "successor" }, { controllerLeaseExpiresAt: new Date(3000) }, { status: "cancelled" },
    { resultJson: { earlySession: { sessionId: "other", sessionParams: { cwd: "/work" } } } },
  ]) {
    const f = fixture();
    f.setRun(patch);
    expect(await inspectHeldOpenCodeRun(f.input)).toMatchObject({ state: "unverified", reason: "ownership_or_binding_changed" });
  }
});

it("discards an observation when the adapter configuration changes during inspection", async () => {
  const f = fixture();
  f.setAgent({ adapterConfig: { nativeRuntime: "nar", sharedServerRecoveryConfigPath: "/other" } });
  expect(await inspectHeldOpenCodeRun(f.input)).toMatchObject({ state: "unverified", reason: "ownership_or_binding_changed" });
});

it("does not inspect a mismatched issue scope or different company", async () => {
  const f = fixture();
  f.run.contextSnapshot.issueId = "other";
  expect(await inspectHeldOpenCodeRun(f.input)).toMatchObject({ state: "unverified", reason: "task_scope_changed" });
  expect(f.inspect).not.toHaveBeenCalled();
  f.run.contextSnapshot.issueId = "issue";
  f.agent.companyId = "other";
  expect(await inspectHeldOpenCodeRun(f.input)).toMatchObject({ state: "unverified", reason: "run_not_eligible" });
  expect(f.inspect).not.toHaveBeenCalled();
});
