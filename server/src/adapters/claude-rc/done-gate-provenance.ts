/** SCO-975: completion evidence comes from the adapter's dispatch checkpoint. */
import fs from "node:fs/promises";
import path from "node:path";
import type { GateDeps, GateReceipt, GateVerdict } from "./done-gate.js";
import { dirtyFingerprints, statusPaths } from "./done-gate-worktree.js";

export type GateBaseline = {
  runId: string;
  repos: Array<{ repo: string; head: string; dirtyPaths?: string[]; dirtyFingerprints?: Record<string, string> }>;
};
const SHA = /^[0-9a-f]{40}$/i;

/** Called before dispatch; a receipt must never supply or replace this record. */
export async function captureDoneGateBaseline(runId: string, deps: GateDeps): Promise<GateBaseline> {
  const repos: GateBaseline["repos"] = [];
  for (const repo of await deps.repos()) {
    const head = await deps.git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    // Unborn repositories remain absent; completion rechecks that they stayed unborn.
    if (head.code === 0 && !head.error && SHA.test(head.out.trim())) {
      const dirty = await deps.git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const dirtyPaths = statusPaths(dirty.out);
      repos.push({ repo: await fs.realpath(repo), head: head.out.trim(),
        ...(dirty.code === 0 && !dirty.error ? { dirtyPaths,
          dirtyFingerprints: await dirtyFingerprints(repo, dirtyPaths, deps) } : {}) });
    }
  }
  return { runId, repos };
}

/** Unknown tools are settled against every original dispatch repository, never prose. */
export async function baselineMutationPaths(receipt: GateReceipt, deps: GateDeps, baseline: GateBaseline, observedCommits: string[] = []): Promise<string[]> {
  if (!baseline.runId || receipt.runId !== baseline.runId || !Array.isArray(baseline.repos) || !baseline.repos.length)
    throw new Error("completion receipt does not match a complete dispatch baseline");
  for (const repo of await deps.repos()) {
    const canonical = await fs.realpath(repo);
    if (!baseline.repos.some(start => start.repo === canonical)) {
      const head = await deps.git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
      // Match capture's omission of unborn repositories, without exempting a
      // repository that gained its first commit after dispatch.
      if (head.code !== 0 && !head.error) continue;
      throw new Error(`dispatch baseline unavailable for repository ${canonical}`);
    }
  }
  const paths = new Set<string>();
  const notMine = new Set(Array.isArray(receipt.notMine) ? receipt.notMine.filter((s): s is string => typeof s === "string") : []);
  for (const start of baseline.repos) {
    const git = async (args: string[]) => {
      const r = await deps.git(start.repo, args);
      if (r.code !== 0 || r.error) throw new Error(`git ${args[0]} baseline evidence failed in ${start.repo}`);
      return r.out;
    };
    if (!SHA.test(start.head)) throw new Error("invalid dispatch baseline HEAD");
    await git(["merge-base", "--is-ancestor", start.head, "HEAD"]);
    let committed = (await git(["diff", "--name-only", "--no-renames", "-z", start.head, "HEAD"])).split("\0").filter(Boolean);
    // A positive commit result in this run scopes committed candidates. A
    // concurrent commit is not this run's mutation merely because HEAD moved.
    // Explicit Edit/Write targets are unioned separately and never exempted.
    if (observedCommits.length) {
      const own = new Set<string>();
      for (const sha of observedCommits) {
        const exists = await deps.git(start.repo, ["cat-file", "-e", `${sha}^{commit}`]);
        if (exists.error) throw new Error("observed commit evidence unavailable");
        if (exists.code !== 0) continue;
        for (const rel of (await git(["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-z", "-r", sha])).split("\0").filter(Boolean)) own.add(rel);
      }
      committed = committed.filter(rel => own.has(rel));
    }
    const dirty = statusPaths(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    const baselineDirty = new Set(start.dirtyPaths ?? []);
    const fingerprints = start.dirtyFingerprints
      ? await dirtyFingerprints(start.repo, dirty.filter(rel => baselineDirty.has(rel)), deps) : {};
    for (const rel of committed) paths.add(path.join(start.repo, rel));
    for (const rel of dirty) {
      const absolute = path.join(start.repo, rel);
      if (start.dirtyFingerprints?.[rel] && start.dirtyFingerprints[rel] === fingerprints[rel]) continue;
      // A legacy baseline without dirt evidence cannot grant an exemption.
      if (!start.dirtyFingerprints && baselineDirty.has(rel) && (notMine.has(rel) || notMine.has(absolute))) continue;
      paths.add(absolute);
    }
  }
  return [...paths];
}

/** Paths are canonicalized by the gate. Other workers' paths are not inspected. */
export async function validateCompletionProvenance(
  receipt: GateReceipt,
  touched: Map<string, string[]>,
  deps: GateDeps,
  baseline?: GateBaseline,
): Promise<GateVerdict> {
  if (!touched.size) return { ok: true, notes: [] };
  const unknown = (reason: string): GateVerdict => ({ ok: false, evidence: "unknown", reasons: [reason] });
  if (!baseline || !baseline.runId || !Array.isArray(baseline.repos))
    return unknown("run baseline unavailable: edited paths require the original adapter dispatch checkpoint");
  if (receipt.runId !== baseline.runId)
    return unknown("completion receipt does not match the recorded baseline run");
  const reasons: string[] = [];
  const commits = Array.isArray(receipt.commits)
    ? receipt.commits.filter((s): s is string => typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s)) : [];
  const claimed = new Set<string>();
  if (!commits.length) reasons.push("receipt has no commits for the recorded run mutations");
  try {
    const git = async (repo: string, args: string[], negative = false) => {
      const result = await deps.git(repo, args);
      if (result.error || (result.code !== 0 && !(negative && result.code === 1)))
        throw new Error(`git ${args[0]} evidence failed in ${repo} (exit ${result.code}${result.error ? `; ${result.error}` : ""})`);
      return result;
    };
    for (const [repo, files] of touched) {
      const start = baseline.repos.find(b => b.repo === repo);
      if (!start || !SHA.test(start.head)) return unknown(`run baseline unavailable for edited repository ${repo}`);
      if ((await git(repo, ["merge-base", "--is-ancestor", start.head, "HEAD"], true)).code !== 0)
        return unknown(`recorded baseline is not on ${repo} HEAD`);
      const relative = [...new Set(files.map(file => path.relative(repo, file)))];
      const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const ownPaths = new Set(relative);
      if (statusPaths(status.out).some(rel => ownPaths.has(rel))) reasons.push(`uncommitted edits of this run in ${repo}; notMine cannot exempt independently recorded run mutations`);
      const covered = new Set<string>();
      const netPaths = new Set((await git(repo, ["diff", "--name-only", "--no-renames", "-z", start.head, "HEAD"])).out.split("\0").filter(Boolean));
      for (const sha of commits) {
        // An object in a different repo is never evidence for these paths.
        const exists = await deps.git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
        if (exists.error) throw new Error("commit object evidence failed");
        if (exists.code !== 0) continue;
        if ((await git(repo, ["merge-base", "--is-ancestor", start.head, sha], true)).code !== 0
          || (await git(repo, ["merge-base", "--is-ancestor", sha, start.head], true)).code === 0
          || (await git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"], true)).code !== 0) continue;
        const changedPaths = new Set((await git(repo, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-z", "-r", sha])).out.split("\0").filter(Boolean));
        const subsequent = new Set((await git(repo, ["diff", "--name-only", "--no-renames", "-z", sha, "HEAD"])).out.split("\0").filter(Boolean));
        for (const rel of relative) {
          if (!changedPaths.has(rel)) continue;
          // Proves the cited commit contains the current content/mode/deletion,
          // and that it represents a net change since the dispatch baseline.
          if (netPaths.has(rel)) {
            claimed.add(sha);
            if (!subsequent.has(rel)) covered.add(rel);
          }
        }
      }
      const uncovered = relative.filter(rel => !covered.has(rel));
      if (uncovered.length) reasons.push(`no completion commit carries ${repo} current content after this run's baseline (${uncovered.length} paths): ${uncovered.slice(0, 12).join(", ")}`);
    }
    for (const sha of commits) if (!claimed.has(sha)) reasons.push(`commit ${sha} is unrelated to the recorded run changes`);
  } catch (error) {
    return unknown(`completion provenance unknown: ${error instanceof Error ? error.message : "Git evidence unavailable"}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, notes: [] };
}
