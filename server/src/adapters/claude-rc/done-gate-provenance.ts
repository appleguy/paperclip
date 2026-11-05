/** SCO-975: completion evidence comes from the adapter's dispatch checkpoint. */
import fs from "node:fs/promises";
import path from "node:path";
import type { GateDeps, GateReceipt, GateVerdict } from "./done-gate.js";

export type GateBaseline = {
  runId: string;
  repos: Array<{ repo: string; head: string; dirtyPaths?: string[] }>;
};
const SHA = /^[0-9a-f]{40}$/i;

/** Called before dispatch; a receipt must never supply or replace this record. */
export async function captureDoneGateBaseline(runId: string, deps: GateDeps): Promise<GateBaseline> {
  const repos: GateBaseline["repos"] = [];
  for (const repo of await deps.repos()) {
    const head = await deps.git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    // Missing/unborn repositories remain absent and cannot establish completion.
    if (head.code === 0 && !head.error && SHA.test(head.out.trim())) {
      const dirty = await deps.git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      repos.push({ repo: await fs.realpath(repo), head: head.out.trim(),
        ...(dirty.code === 0 && !dirty.error ? { dirtyPaths: statusPaths(dirty.out) } : {}) });
    }
  }
  return { runId, repos };
}

// --no-renames is not supported by status on all installed Git versions.
function statusPaths(out: string): string[] {
  const records = out.split("\0"), paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.length < 4) continue;
    paths.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2)) && records[i + 1]) paths.push(records[++i]);
  }
  return paths;
}

/** Unknown tools are settled against every original dispatch repository, never prose. */
export async function baselineMutationPaths(receipt: GateReceipt, deps: GateDeps, baseline: GateBaseline): Promise<string[]> {
  if (!baseline.runId || receipt.runId !== baseline.runId || !Array.isArray(baseline.repos) || !baseline.repos.length)
    throw new Error("completion receipt does not match a complete dispatch baseline");
  for (const repo of await deps.repos()) {
    const canonical = await fs.realpath(repo);
    if (!baseline.repos.some(start => start.repo === canonical))
      throw new Error(`dispatch baseline unavailable for repository ${canonical}`);
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
    const committed = (await git(["diff", "--name-only", "--no-renames", "-z", start.head, "HEAD"])).split("\0").filter(Boolean);
    const dirty = statusPaths(await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    for (const rel of [...committed, ...dirty]) {
      const absolute = path.join(start.repo, rel);
      // A legacy baseline without dirt evidence cannot grant an exemption.
      if (start.dirtyPaths?.includes(rel) && (notMine.has(rel) || notMine.has(absolute))) continue;
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
      const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...relative]);
      if (status.out) reasons.push(`uncommitted edits of this run in ${repo}; notMine cannot exempt independently recorded run mutations`);
      const covered = new Set<string>();
      for (const sha of commits) {
        // An object in a different repo is never evidence for these paths.
        const exists = await deps.git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
        if (exists.error) throw new Error("commit object evidence failed");
        if (exists.code !== 0) continue;
        if ((await git(repo, ["merge-base", "--is-ancestor", start.head, sha], true)).code !== 0
          || (await git(repo, ["merge-base", "--is-ancestor", sha, start.head], true)).code === 0
          || (await git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"], true)).code !== 0) continue;
        for (const rel of relative) {
          const changed = await git(repo, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--name-only", "-r", sha, "--", rel]);
          if (!changed.out.split("\n").includes(rel)) continue;
          // Proves the cited commit contains the current content/mode/deletion,
          // and that it represents a net change since the dispatch baseline.
          const current = await git(repo, ["diff", "--quiet", sha, "HEAD", "--", rel], true);
          const net = await git(repo, ["diff", "--quiet", start.head, "HEAD", "--", rel], true);
          if (net.code === 1) {
            claimed.add(sha);
            if (current.code === 0) covered.add(rel);
          }
        }
      }
      for (const rel of relative) if (!covered.has(rel)) reasons.push(`no completion commit carries ${repo}/${rel} current content after this run's baseline`);
    }
    for (const sha of commits) if (!claimed.has(sha)) reasons.push(`commit ${sha} is unrelated to the recorded run changes`);
  } catch (error) {
    return unknown(`completion provenance unknown: ${error instanceof Error ? error.message : "Git evidence unavailable"}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, notes: [] };
}
