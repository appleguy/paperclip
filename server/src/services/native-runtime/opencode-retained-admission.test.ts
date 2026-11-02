import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ host: null as any, profileGate: null as Promise<void> | null }));
vi.mock("./opencode-provider-profile.js", () => ({ resolveOpenCodeSharedProvider: async () => { await state.profileGate; return { baseUrl: "http://fixture", key: "private", model: "model", provider: "fixture" }; } }));
vi.mock("./opencode-shared-host.js", () => ({ startOpenCodeSharedHost: async () => state.host }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({ ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(), startOpenCodeProviderProxy: async () => ({ baseURL: "http://fixture", token: "private", close: async () => {} }) }));
import { getOpenCodeRetainedOwnership, startOpenCodeManagedBackend } from "./opencode-managed-admission.js";

it("serializes same-run startup before asynchronous provider resolution and releases a failed reservation", async () => {
  let release!: () => void;
  state.profileGate = new Promise<void>(resolve => { release = resolve; });
  const input: any = { execution: { binding: { runId: "concurrent" }, workspace: { cwd: "/fixture" }, provider: { model: "fixture/model" } }, environment: {} };
  const failure = new Error("lease unavailable");
  const db: any = { transaction: vi.fn(async () => { throw failure; }) };
  const first = startOpenCodeManagedBackend(db, input);
  await expect(startOpenCodeManagedBackend(db, input)).rejects.toThrow("unavailable_or_pending");
  expect(db.transaction).not.toHaveBeenCalled();
  release();
  await expect(first).rejects.toBe(failure);
  state.profileGate = null;
  await expect(startOpenCodeManagedBackend(db, input)).rejects.toBe(failure);
  expect(db.transaction).toHaveBeenCalledTimes(2);
});

it("retains the exact launched host and original catalog failure when shutdown cannot join", async () => {
  const failure = new Error("catalog failed");
  state.host = { generation: "generation", prepareManagedSession: vi.fn(async () => {}), verifyCatalog: vi.fn(async () => { throw failure; }), shutdown: vi.fn(async () => { throw new Error("exit unknown"); }), createManagedSession: vi.fn() };
  let i = 0;
  const rows = [[{ controllerGeneration: 7 }], [{}], [{ projectId: "project" }], [], [{ id: "task" }], [{}]];
  const tx: any = { select: () => { const value = rows[i++] ?? []; const chain: any = { from: () => chain, where: () => chain, for: () => chain, limit: async () => value }; return chain; }, insert: () => ({ values: async () => {} }) };
  const db: any = { transaction: async (fn: any) => fn(tx) };
  const input: any = { execution: { binding: { companyId: "company", issueId: "issue", agentId: "agent", runId: "run" }, workspace: { cwd: "/fixture" }, session: { normalizedSessionId: "session" }, provider: { model: "fixture/model", effort: "high" } }, runnerInstanceId: "runner", leaseOwner: "lease", attempt: 1, controller: { bootId: "boot", pid: 42, processStartedAt: new Date(1) }, executable: "/fixture", dataRoot: "/fixture", environment: {}, authority: { definitions: () => [] } };
  await expect(startOpenCodeManagedBackend(db, input)).rejects.toBe(failure);
  const ownership = getOpenCodeRetainedOwnership({ runId: "run", leaseOwner: "lease", attempt: 1, controllerGeneration: 7 });
  expect(ownership).toMatchObject({ durable: true, cause: failure, binding: { runId: "run", generation: "generation", leaseOwner: "lease", leaseAttempt: 1 } });
  expect(() => getOpenCodeRetainedOwnership({ runId: "run", leaseOwner: "foreign", attempt: 1, controllerGeneration: 7 })).toThrow("owner_mismatch");
  expect(state.host.createManagedSession).not.toHaveBeenCalled();
  await expect(startOpenCodeManagedBackend(db, input)).rejects.toThrow("unavailable_or_pending");
  const persistenceError = new Error("persistence failed");
  state.host = { generation: "second-generation", prepareManagedSession: vi.fn(async () => { throw persistenceError; }), verifyCatalog: vi.fn(), shutdown: vi.fn(), createManagedSession: vi.fn() };
  i = 0;
  const second = { ...input, execution: { ...input.execution, binding: { ...input.execution.binding, runId: "run-two" } } };
  await expect(startOpenCodeManagedBackend(db, second)).rejects.toBe(persistenceError);
  expect(getOpenCodeRetainedOwnership({ runId: "run-two", leaseOwner: "lease", attempt: 1, controllerGeneration: 7 })).toMatchObject({ durable: false, cause: persistenceError, binding: { generation: "second-generation" } });
  expect(state.host.createManagedSession).not.toHaveBeenCalled();
});
