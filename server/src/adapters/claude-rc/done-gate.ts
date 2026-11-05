/**
 * Done gate (SCO-762): a fix only counts once it is committed on the canonical
 * checkout and, for Paperclip, live or queued for the autodeploy watcher.
 * The gate decides from facts, not from the worker's prose:
 *  - the run's durable transcript must account for mutations, including uncertainty;
 *  - those files must be clean in git (no own uncommitted edits);
 *  - the receipt must list the commit SHA(s); each must be on the checkout's HEAD;
 *  - Paperclip SHAs must be live (ancestor of cli/current) or queued (ancestor of master HEAD);
 *  - a commit touching owner-visible UI must already be live and carry `liveCheck`
 *    (rendered-surface evidence with before/after), never "a reload should confirm".
 * Arbitrary shell/agent tools cannot prove their write set from command prose.
 * Without a run baseline they yield unknown, never an inferred read-only success.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PAPERCLIP_MASTER = "/Volumes/NVM/Paperclip/master";
export const PAPERCLIP_CURRENT = "/Volumes/NVM/Paperclip/cli/current";
export const PROJECTS_ROOT = "/Volumes/NVM/AI_Coding_Projects";
const UI_PREFIXES = ["ui/", "master/ui/"];

export type GateReceipt = { commits?: unknown; liveCheck?: unknown; notMine?: unknown };
export type GateVerdict = { ok: true; notes: string[] } | { ok: false; reasons: string[]; evidence?: "unknown" };
export type MutationRecord = { paths: string[]; unknown: string[] };
export type GitEvidence = { code: number; out: string; error?: string };

export type GateDeps = {
  repos(): Promise<string[]>;
  git(repo: string, args: string[]): Promise<GitEvidence>;
  liveSha(): Promise<string | null>;
};

// Only tools with a known nonmutating contract may establish read-only work.
// Shell, nested agents and new tools remain unknown until a durable write set exists.
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);

/** Run mutation record from the durable Claude transcript; keep incomplete evidence. */
export function editedPaths(jsonl: string, sinceMs: number): MutationRecord {
  const seen = new Set<string>();
  const unknown = new Set<string>();
  if (!jsonl.trim()) unknown.add("transcript was read successfully but is empty; no run-owned mutation evidence");
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec: { timestamp?: string; cwd?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { unknown.add("transcript contains an unreadable record"); continue; }
    if (!rec || typeof rec !== "object") { unknown.add("transcript contains an invalid record"); continue; }
    const t = Date.parse(rec.timestamp ?? "");
    if (Number.isFinite(t) && t < sinceMs) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (c?.type !== "tool_use") continue;
      if (sinceMs > 0 && !Number.isFinite(t)) {
        unknown.add("tool record has no run timestamp");
        continue;
      }
      if (READ_ONLY_TOOLS.has(c.name ?? "")) continue;
      if (!["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(c.name ?? "")) {
        unknown.add(`write set unavailable for tool ${c.name ?? "unnamed"}`);
        continue;
      }
      const p = c.input?.file_path ?? c.input?.notebook_path;
      if (typeof p !== "string" || !p.trim()) { unknown.add("mutation tool has no target path"); continue; }
      if (path.isAbsolute(p)) seen.add(path.normalize(p));
      else if (typeof rec.cwd === "string" && path.isAbsolute(rec.cwd)) seen.add(path.resolve(rec.cwd, p));
      else unknown.add(`relative mutation path has no absolute cwd: ${p}`);
    }
  }
  return { paths: [...seen], unknown: [...unknown] };
}

/** Resolve aliases even for deleted/new targets, using their nearest existing parent. */
async function canonicalPath(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalPath(parent), path.basename(file));
  }
}

export function repoOf(file: string, repos: string[]): string | null {
  let best: string | null = null;
  for (const r of repos) {
    if ((file === r || file.startsWith(r + path.sep)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

const SHA = /^[0-9a-f]{7,40}$/i;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function errorDetail(error: unknown): string {
  const e = error as { code?: unknown; signal?: unknown; killed?: unknown } | null;
  return [e?.killed ? "timed out or killed" : "command/read failed", e?.code, e?.signal]
    .filter(v => typeof v === "string" || typeof v === "number").join(" ");
}

function unknownEvidence(reason: string): GateVerdict {
  return { ok: false, evidence: "unknown", reasons: [reason] };
}

export async function evaluateDoneGate(receipt: GateReceipt, edited: string[] | MutationRecord, deps: GateDeps): Promise<GateVerdict> {
  // A dependency rejection (including timeouts) is evidence failure, not clean output.
  const git = async (repo: string, args: string[]): Promise<GitEvidence> => {
    try { return await deps.git(repo, args); }
    catch (error) { return { code: 1, out: "", error: errorDetail(error) }; }
  };
  const gitFailure = (repo: string, command: string, result: GitEvidence) =>
    unknownEvidence(`Git evidence unknown: git ${command} in ${repo} failed (exit ${result.code}${result.error ? `; ${result.error}` : ""}). Restore Git access and retry; empty output is not proof of a clean checkout.`);
  const record = Array.isArray(edited) ? { paths: edited, unknown: [] } : edited;
  if (record.unknown.length) return { ok: false, evidence: "unknown", reasons: [`mutation evidence unknown: ${record.unknown.join("; ")}. A complete run-owned mutation record or baseline is required; commit prose cannot establish the write set.`] };
  const repos = await deps.repos();
  const resolvedRepos = new Map<string, string>();
  try {
    for (const repo of repos) resolvedRepos.set(await canonicalPath(repo), repo);
  } catch { return { ok: false, evidence: "unknown", reasons: ["mutation evidence unknown: checkout alias resolution failed"] }; }
  const touched = new Map<string, string[]>(); // repo -> edited files
  for (const file of record.paths) {
    if (!path.isAbsolute(file)) return { ok: false, evidence: "unknown", reasons: ["mutation evidence unknown: relative path has no run cwd"] };
    let f: string;
    try { f = await canonicalPath(file); }
    catch { return { ok: false, evidence: "unknown", reasons: ["mutation evidence unknown: target alias resolution failed"] }; }
    const resolved = repoOf(f, [...resolvedRepos.keys()]);
    const r = resolved ? resolvedRepos.get(resolved)! : null;
    if (r && resolved) touched.set(r, [...(touched.get(r) ?? []), path.join(r, path.relative(resolved, f))]);
  }
  const commits = strings(receipt.commits).map(s => s.trim());
  if (touched.size === 0 && commits.length === 0) return { ok: true, notes: ["no canonical repo edited"] };

  const reasons: string[] = [];
  const notes: string[] = [];
  const notMine = new Set(strings(receipt.notMine));

  // Own uncommitted edits: the run's edited files that git still reports dirty.
  for (const [repo, files] of touched) {
    const st = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files.map(f => path.relative(repo, f))]);
    if (st.code !== 0 || st.error) return gitFailure(repo, "status", st);
    const dirty = st.out.split("\0").filter(l => l.length > 3).map(l => l.slice(3)).filter(p => !notMine.has(p));
    if (dirty.length) reasons.push(`uncommitted edits of this run in ${repo}: ${dirty.slice(0, 12).join(", ")}${dirty.length > 12 ? ` (+${dirty.length - 12})` : ""}. Commit your own paths on the checkout (git add <paths>; git commit) or revert them; if the dirt is another agent's, list those paths in "notMine". Then resubmit.`);
  }
  if (touched.size > 0 && commits.length === 0)
    reasons.push(`receipt has no commits: this run edited ${[...touched.keys()].join(", ")}. Add "commits": ["<sha>", ...] (the SHAs that carry your change).`);

  const live = await deps.liveSha();
  let ownerVisible = false;
  for (const sha of commits) {
    if (!SHA.test(sha)) { reasons.push(`commit "${sha}" is not a hex SHA`); continue; }
    let found: string | null = null;
    for (const repo of repos) {
      const exists = await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
      if (exists.error) return gitFailure(repo, "cat-file", exists);
      if (exists.code === 0) { found = repo; break; }
    }
    if (!found) { reasons.push(`commit ${sha} is in no canonical checkout`); continue; }
    const onHead = await git(found, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    if (onHead.error || (onHead.code !== 0 && onHead.code !== 1)) return gitFailure(found, "merge-base HEAD", onHead);
    if (onHead.code !== 0) {
      reasons.push(`commit ${sha} is not on ${found} HEAD (canonical main); land it there first`);
      continue;
    }
    if (found !== PAPERCLIP_MASTER) { notes.push(`${sha.slice(0, 12)} on ${found}`); continue; }
    const shown = await git(found, ["show", "--name-only", "--format=", sha]);
    if (shown.code !== 0 || shown.error) return gitFailure(found, "show", shown);
    const files = shown.out.split("\n");
    const isUi = files.some(f => UI_PREFIXES.some(p => f.startsWith(p)));
    const liveAncestor = live === null ? null : await git(found, ["merge-base", "--is-ancestor", sha, live]);
    if (liveAncestor && (liveAncestor.error || (liveAncestor.code !== 0 && liveAncestor.code !== 1))) return gitFailure(found, "merge-base live", liveAncestor);
    const isLive = liveAncestor?.code === 0;
    notes.push(`${sha.slice(0, 12)} ${isLive ? "live" : "queued for autodeploy"}`);
    if (isUi) {
      ownerVisible = true;
      if (!isLive) reasons.push(`commit ${sha} changes owner-visible UI but is not live yet (cli/current ${live?.slice(0, 12) ?? "unknown"}). Wait for autodeploy (HEAD must be 10 min old) or run bin/pc-deploy, then resubmit.`);
    }
  }
  if (ownerVisible && !(typeof receipt.liveCheck === "string" && receipt.liveCheck.trim().length >= 20))
    reasons.push(`owner-visible change needs "liveCheck": the rendered surface checked after deploy, e.g. curl -sk https://Scotts-Mac-Pro.local/<page> | rg -c '<string>' with before and after counts. "A reload should confirm" is not done.`);

  return reasons.length ? { ok: false, reasons } : { ok: true, notes };
}

export function productionDeps(): GateDeps {
  return {
    repos: async () => {
      const out = [PAPERCLIP_MASTER];
      for (const e of await fs.readdir(PROJECTS_ROOT, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory() && await fs.stat(path.join(PROJECTS_ROOT, e.name, ".git")).then(s => s.isDirectory(), () => false))
          out.push(path.join(PROJECTS_ROOT, e.name));
      }
      return out;
    },
    git: async (repo, args) => {
      try {
        const { stdout } = await run("/usr/bin/git", ["-C", repo, ...args], { timeout: 20_000, maxBuffer: 8_000_000 });
        return { code: 0, out: stdout.replace(/\n+$/, "") }; // not trim(): status lines start with a space
      } catch (e) {
        const err = e as { code?: number | string; stdout?: string; killed?: boolean };
        return { code: typeof err.code === "number" ? err.code : 1, out: (err.stdout ?? "").replace(/\n+$/, ""),
          // Exit 1 from merge-base and absent objects from cat-file are normal
          // negative answers. Transport/timeout failures are never negatives.
          ...(err.killed || typeof err.code !== "number" ? { error: errorDetail(e) } : {}),
        };
      }
    },
    liveSha: async () => {
      try {
        const short = path.basename(await fs.readlink(PAPERCLIP_CURRENT));
        const { stdout } = await run("/usr/bin/git", ["-C", PAPERCLIP_MASTER, "rev-parse", "--verify", `${short}^{commit}`], { timeout: 10_000 });
        return stdout.trim();
      } catch { return null; }
    },
  };
}

/** Message typed back to the worker when the gate refuses; single line (TUI submit refuses newlines). Leading "From:" envelope keeps owner-capture from recording it as owner typing (SCO-806). */
export function refusalMessage(reasons: string[], attempt: number, max: number): string {
  return `From: paperclip-done-gate | DONE GATE refused your receipt (${attempt}/${max}, SCO-762): ${reasons.join(" | ")} Fix this, then write the receipt again at the same path. Do not close the issue yourself.`;
}

/** Gate a raw receipt file against the run's transcript; used by the claude_rc adapter before deliver(). */
export async function gateReceiptRaw(raw: string, transcriptPath: string | null, sinceMs: number, deps: GateDeps = productionDeps()): Promise<GateVerdict> {
  let receipt: GateReceipt;
  try { receipt = JSON.parse(raw) as GateReceipt; } catch { return { ok: false, reasons: ["receipt is not valid JSON"] }; }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { ok: false, reasons: ["receipt must be a JSON object"] };
  if (!transcriptPath) return unknownEvidence("Transcript evidence unknown: no transcript path is available. Restore the run transcript before resubmitting.");
  let jsonl: string;
  try { jsonl = await fs.readFile(transcriptPath, "utf8"); }
  catch (error) { return unknownEvidence(`Transcript evidence unknown: cannot read ${transcriptPath} (${errorDetail(error)}). Restore the run transcript and read access before resubmitting.`); }
  return evaluateDoneGate(receipt, editedPaths(jsonl, sinceMs), deps);
}
