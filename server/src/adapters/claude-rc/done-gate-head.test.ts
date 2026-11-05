import fs from "node:fs/promises";
import { expect, it } from "vitest";
import type { GateDeps } from "./done-gate.js";
import { baselineMutationPaths, captureDoneGateBaseline } from "./done-gate-provenance.js";

const repo = await fs.realpath(".");
const sha = "a".repeat(40);
const healthyGit: GateDeps["git"] = async (_repo, args) => ({ code: 0, out: args[0] === "rev-parse" ? sha : "" });
const depsFor = (git: GateDeps["git"]): GateDeps => ({ git, repos: async () => [repo], liveSha: async () => null });

it.each(["timeout", "spawn", "rejection"])("recovers one transient HEAD %s without omitting the repo", async failure => {
  let reads = 0;
  const deps = depsFor(async (cwd, args) => {
    if (args[0] === "rev-parse" && ++reads === 1) {
      if (failure === "rejection") throw new Error("spawn failure");
      return { code: 1, out: "", error: failure };
    }
    return healthyGit(cwd, args);
  });
  const baseline = await captureDoneGateBaseline("run", deps);
  expect(reads).toBe(2);
  expect(baseline.repos).toMatchObject([{ repo, head: sha }]);
  expect(baseline.unavailableRepos).toEqual([]);
});

it.each([
  { code: 1, out: "", error: "timeout" },
  { code: 1, out: "", error: "spawn ENOENT" },
  { code: 128, out: "" },
  { code: 0, out: "malformed SHA" },
])("records persistent unavailable HEAD evidence and never repairs it at completion: %j", async failed => {
  let reads = 0;
  const baseline = await captureDoneGateBaseline("run", depsFor(async (cwd, args) => {
    if (args[0] === "rev-parse") { reads++; return failed; }
    return healthyGit(cwd, args); // no valid symbolic branch evidence
  }));
  expect(reads).toBe(2);
  expect(baseline.unavailableRepos).toEqual([repo]);
  // A later healthy HEAD must not manufacture the missing dispatch evidence.
  await expect(baselineMutationPaths({ runId: "run" }, depsFor(healthyGit), baseline)).rejects.toThrow();
});

it("requires a missing symbolic branch ref to classify unborn, and rejects its first commit", async () => {
  const unborn: GateDeps["git"] = async (_repo, args) => {
    if (args[0] === "rev-parse") return { code: 128, out: "" };
    if (args[0] === "symbolic-ref") return { code: 0, out: "refs/heads/main" };
    return { code: 1, out: "" };
  };
  const baseline = await captureDoneGateBaseline("run", depsFor(unborn));
  expect(baseline.unbornRepos).toEqual([repo]);
  expect(await baselineMutationPaths({ runId: "run" }, depsFor(unborn), baseline)).toEqual([]);
  await expect(baselineMutationPaths({ runId: "run" }, depsFor(healthyGit), baseline))
    .rejects.toThrow("dispatch baseline unavailable");
  const corrupt = depsFor(async (cwd, args) => args[0] === "show-ref" ? { code: 0, out: "" } : unborn(cwd, args));
  expect((await captureDoneGateBaseline("run", corrupt)).unavailableRepos).toEqual([repo]);
});

it("retries completion HEAD failures for legacy omissions but refuses persistent failures", async () => {
  const baseline = { runId: "run", repos: [{ repo, head: sha }] };
  // A second directory models a repo omitted by a legacy dispatch snapshot.
  const omitted = await fs.realpath("server");
  let reads = 0;
  const deps: GateDeps = { ...depsFor(healthyGit), repos: async () => [repo, omitted], git: async (cwd, args) => {
    if (cwd !== omitted) return healthyGit(cwd, args);
    if (args[0] === "rev-parse") return ++reads === 1
      ? { code: 1, out: "", error: "timeout" } : { code: 128, out: "" };
    if (args[0] === "symbolic-ref") return { code: 0, out: "refs/heads/main" };
    return { code: 1, out: "" };
  } };
  expect(await baselineMutationPaths({ runId: "run" }, deps, baseline)).toEqual([]);
  expect(reads).toBe(2);
  deps.git = async (cwd, args) => cwd === omitted ? { code: 128, out: "" } : healthyGit(cwd, args);
  await expect(baselineMutationPaths({ runId: "run" }, deps, baseline)).rejects.toThrow("dispatch baseline unavailable");
});
