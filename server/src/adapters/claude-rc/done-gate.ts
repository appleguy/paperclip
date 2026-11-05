/**
 * Done gate (SCO-762): a fix only counts once it is committed on the canonical
 * checkout and, for Paperclip, live or queued for the autodeploy watcher.
 * The gate decides from facts, not from the worker's prose:
 *  - "the run changed a canonical repo" = the run's own transcript edited a file under one;
 *  - those files must be clean in git (no own uncommitted edits);
 *  - the receipt must list the commit SHA(s); each must be on the checkout's HEAD;
 *  - Paperclip SHAs must be live (ancestor of cli/current) or queued (ancestor of master HEAD);
 *  - a commit touching owner-visible UI must already be live and carry `liveCheck`
 *    (rendered-surface evidence with before/after), never "a reload should confirm".
 * Transcript detection sees Edit/Write/NotebookEdit tool calls; shell-only edits (sed -i)
 * are caught only when the worker lists commits or the files show up dirty via those tools.
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
export type GateVerdict = { ok: true; notes: string[] } | { ok: false; reasons: string[] };

export type GateDeps = {
  repos(): Promise<string[]>;
  git(repo: string, args: string[]): Promise<{ code: number; out: string }>;
  liveSha(): Promise<string | null>;
};

/** File paths the run edited, from a Claude Code transcript (JSONL), at or after sinceMs. */
export function editedPaths(jsonl: string, sinceMs: number): string[] {
  const seen = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let rec: { timestamp?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; }
    const t = Date.parse(rec.timestamp ?? "");
    if (Number.isFinite(t) && t < sinceMs) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (c?.type !== "tool_use" || !["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(c.name ?? "")) continue;
      const p = c.input?.file_path ?? c.input?.notebook_path;
      if (typeof p === "string" && path.isAbsolute(p)) seen.add(path.normalize(p));
    }
  }
  return [...seen];
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

export async function evaluateDoneGate(receipt: GateReceipt, edited: string[], deps: GateDeps): Promise<GateVerdict> {
  const repos = await deps.repos();
  const touched = new Map<string, string[]>(); // repo -> edited files
  for (const f of edited) {
    const r = repoOf(f, repos);
    if (r) touched.set(r, [...(touched.get(r) ?? []), f]);
  }
  const commits = strings(receipt.commits).map(s => s.trim());
  if (touched.size === 0 && commits.length === 0) return { ok: true, notes: ["no canonical repo edited"] };

  const reasons: string[] = [];
  const notes: string[] = [];
  const notMine = new Set(strings(receipt.notMine));

  // Own uncommitted edits: the run's edited files that git still reports dirty.
  for (const [repo, files] of touched) {
    const st = await deps.git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files.map(f => path.relative(repo, f))]);
    const dirty = st.out.split("\0").filter(l => l.length > 3).map(l => l.slice(3)).filter(p => !notMine.has(p));
    if (dirty.length) reasons.push(`uncommitted edits of this run in ${repo}: ${dirty.slice(0, 12).join(", ")}${dirty.length > 12 ? ` (+${dirty.length - 12})` : ""}. Commit your own paths on the checkout (git add <paths>; git commit) or revert them, then resubmit.`);
  }
  if (touched.size > 0 && commits.length === 0)
    reasons.push(`receipt has no commits: this run edited ${[...touched.keys()].join(", ")}. Add "commits": ["<sha>", ...] (the SHAs that carry your change).`);

  const live = await deps.liveSha();
  let ownerVisible = false;
  for (const sha of commits) {
    if (!SHA.test(sha)) { reasons.push(`commit "${sha}" is not a hex SHA`); continue; }
    let found: string | null = null;
    for (const repo of repos) {
      if ((await deps.git(repo, ["cat-file", "-e", `${sha}^{commit}`])).code === 0) { found = repo; break; }
    }
    if (!found) { reasons.push(`commit ${sha} is in no canonical checkout`); continue; }
    if ((await deps.git(found, ["merge-base", "--is-ancestor", sha, "HEAD"])).code !== 0) {
      reasons.push(`commit ${sha} is not on ${found} HEAD (canonical main); land it there first`);
      continue;
    }
    if (found !== PAPERCLIP_MASTER) { notes.push(`${sha.slice(0, 12)} on ${found}`); continue; }
    const files = (await deps.git(found, ["show", "--name-only", "--format=", sha])).out.split("\n");
    const isUi = files.some(f => UI_PREFIXES.some(p => f.startsWith(p)));
    const isLive = live !== null && (await deps.git(found, ["merge-base", "--is-ancestor", sha, live])).code === 0;
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
        return { code: 0, out: stdout.trim() };
      } catch (e) {
        const err = e as { code?: number | string; stdout?: string };
        return { code: typeof err.code === "number" ? err.code : 1, out: (err.stdout ?? "").trim() };
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

/** Message typed back to the worker when the gate refuses; single line (TUI submit refuses newlines). */
export function refusalMessage(reasons: string[], attempt: number, max: number): string {
  return `DONE GATE refused your receipt (${attempt}/${max}, SCO-762): ${reasons.join(" | ")} Fix this, then write the receipt again at the same path. Do not close the issue yourself.`;
}

/** Gate a raw receipt file against the run's transcript; used by the claude_rc adapter before deliver(). */
export async function gateReceiptRaw(raw: string, transcriptPath: string | null, sinceMs: number, deps: GateDeps = productionDeps()): Promise<GateVerdict> {
  let receipt: GateReceipt;
  try { receipt = JSON.parse(raw) as GateReceipt; } catch { return { ok: false, reasons: ["receipt is not valid JSON"] }; }
  const jsonl = transcriptPath ? await fs.readFile(transcriptPath, "utf8").catch(() => "") : "";
  return evaluateDoneGate(receipt, editedPaths(jsonl, sinceMs), deps);
}
