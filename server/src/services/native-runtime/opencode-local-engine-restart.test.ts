import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ freeze: vi.fn(), resume: vi.fn(), verify: vi.fn(async () => {}) }));
vi.mock("./opencode-host-registry.js", () => ({ freezeOpenCodeManagedHost: calls.freeze, resumeOpenCodeManagedHost: calls.resume, verifyOpenCodeManagedProviderTarget: calls.verify }));
import { restartOpenCodeLocalEngine, type LocalEngineIdentity, type LocalEngineRestartAuthority } from "./opencode-local-engine-restart.js";

const expected: LocalEngineIdentity = { route: "owned-engine", model: "fixture", generation: "old", modelSha256: "1".repeat(64), tokenizerSha256: "2".repeat(64), templateSha256: "3".repeat(64), executableSha256: "4".repeat(64), configSha256: "5".repeat(64) };
const binding = { model: "paperclip/fixture", providerSessionId: "ses_one", controllerProcessStartedAt: new Date(1) } as any;
const checkpoint = { id: "hold", requestSha256: "a".repeat(64) };

function fixture(change: Partial<LocalEngineIdentity> = {}) {
  const events: string[] = [];
  let generation = "old";
  const engine = { identity: vi.fn(async () => { events.push(`identity:${generation}`); return { ...expected, ...(generation === "new" ? change : {}), generation }; }), restart: vi.fn(async () => { events.push("restart"); generation = "new"; }) };
  const authority: LocalEngineRestartAuthority = { async withExclusiveRestart(_binding, _signal, work) { events.push("exclusive"); try { return await work(engine); } finally { events.push("release"); } } };
  calls.freeze.mockReset().mockImplementation(async (_db, _binding, options) => { events.push("freeze"); options.signal.addEventListener("abort", () => events.push("abort")); return checkpoint; });
  calls.resume.mockReset().mockImplementation(async () => { events.push("resume"); });
  const run = () => restartOpenCodeLocalEngine({ db: {} as any, binding, authority, expected, timeoutMs: 1000, signal: new AbortController().signal });
  return { run, events, engine };
}

it("holds the exact run under exclusive admission until a verified restart and resume", async () => {
  const f = fixture();
  await expect(f.run()).resolves.toEqual({ requestSha256: checkpoint.requestSha256, previousGeneration: "old", generation: "new" });
  expect(f.events).toEqual(["exclusive", "identity:old", "freeze", "identity:old", "restart", "identity:new", "resume", "release"]);
  expect(calls.freeze.mock.calls[0]![1]).toEqual(binding);
  expect(calls.resume.mock.calls[0]![2]).toEqual(checkpoint);
});

it.each(["route", "modelSha256", "tokenizerSha256", "templateSha256", "executableSha256", "configSha256"] as const)("never resumes after changed %s", async field => {
  const f = fixture({ [field]: field === "route" ? "other" : "f".repeat(64) });
  await expect(f.run()).rejects.toThrow("restart_unverified");
  expect(calls.resume).not.toHaveBeenCalled();
  expect(f.events).toContain("abort");
  expect(f.events.indexOf("abort")).toBeLessThan(f.events.indexOf("release"));
});

it("rejects unproven identity before acquiring authority", async () => {
  const f = fixture();
  await expect(restartOpenCodeLocalEngine({ db: {} as any, binding, authority: { withExclusiveRestart: vi.fn() } as any, expected: { ...expected, templateSha256: "" }, timeoutMs: 1000, signal: new AbortController().signal })).rejects.toThrow("identity_unproven");
  expect(f.events).toEqual([]);
});
