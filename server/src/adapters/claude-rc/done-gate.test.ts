import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { editedPaths, evaluateDoneGate, gateReceiptRaw, repoOf, type GateDeps } from "./done-gate.js";

const M = "/Volumes/NVM/Paperclip/master";
const Z = "/Volumes/NVM/AI_Coding_Projects/zagent";
const LIVE = "a".repeat(40);

function deps(over: { dirty?: string; known?: Record<string, string>; onHead?: Set<string>; live?: Set<string>; uiFiles?: string } = {}): GateDeps {
  return {
    repos: async () => [M, Z],
    liveSha: async () => LIVE,
    git: async (repo, args) => {
      if (args[0] === "status") return { code: 0, out: over.dirty ?? "" };
      const sha = (args.find(a => /^[0-9a-f]{7,40}(\^\{commit\})?$/i.test(a)) ?? "").replace("^{commit}", "");
      if (args[0] === "cat-file") return { code: (over.known?.[sha] ?? M) === repo ? 0 : 1, out: "" };
      if (args[0] === "merge-base") {
        const target = args[args.length - 1];
        const ok = target === LIVE ? (over.live ?? new Set()).has(sha) : (over.onHead ?? new Set([sha])).has(sha);
        return { code: ok ? 0 : 1, out: "" };
      }
      if (args[0] === "show") return { code: 0, out: over.uiFiles ?? "server/src/x.ts" };
      return { code: 1, out: "" };
    },
  };
}
const sha1 = "b".repeat(40);

describe("editedPaths", () => {
  it("collects Edit/Write targets at or after the run start", () => {
    const line = (ts: string, name: string, p: string) => JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", name, input: { file_path: p } }] } });
    const jsonl = [line("2026-11-05T01:00:00Z", "Edit", `${M}/old.ts`), line("2026-11-05T02:00:00Z", "Write", `${M}/new.ts`), line("2026-11-05T02:01:00Z", "Read", `${M}/r.ts`)].join("\n");
    expect(editedPaths(jsonl, Date.parse("2026-11-05T01:30:00Z"))).toEqual({ paths: [`${M}/new.ts`], unknown: [] });
  });
  it("preserves uncertainty about untimestamped tools instead of assuming replay", () => {
    const replay = JSON.stringify({ message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${M}/replayed.ts` } }] } });
    expect(editedPaths(replay, Date.parse("2026-11-05T01:30:00Z")).unknown).toContain("tool record has no run timestamp");
    expect(editedPaths(replay, 0)).toEqual({ paths: [`${M}/replayed.ts`], unknown: [] });
  });
});

describe("run mutation attribution (SCO-973 / S7 F01)", () => {
  const ts = "2026-11-05T02:00:00Z";
  const tool = (name: string, input: unknown, cwd?: string) => JSON.stringify({ timestamp: ts, cwd, message: { content: [{ type: "tool_use", name, input }] } });

  it("returns unknown for shell and unrecognized tool write sets, even with commit prose", async () => {
    for (const name of ["Bash", "mcp__shell", "Agent"]) {
      const record = editedPaths(tool(name, { command: "sed -i '' s/a/b/ ui/page.ts" }), 1);
      const v = await evaluateDoneGate({ commits: [sha1] }, record, deps());
      expect(v).toMatchObject({ ok: false, evidence: "unknown" });
    }
  });

  it("resolves relative targets from the transcript cwd or preserves unknown", async () => {
    const resolved = editedPaths(tool("Edit", { file_path: "ui/page.ts" }, M), 1);
    expect(resolved).toEqual({ paths: [`${M}/ui/page.ts`], unknown: [] });
    expect((await evaluateDoneGate({}, resolved, deps())).ok).toBe(false);
    const unresolved = editedPaths(tool("Edit", { file_path: "ui/page.ts" }), 1);
    expect(await evaluateDoneGate({}, unresolved, deps())).toMatchObject({ ok: false, evidence: "unknown" });
  });

  it("permits normal read-only work and excludes earlier timestamped mutations", async () => {
    const jsonl = [tool("Bash", { command: "edit" }), tool("Read", { file_path: `${M}/ui/page.ts` }), tool("Grep", { pattern: "x" }), tool("Glob", { pattern: "**/*" })].join("\n");
    expect((await evaluateDoneGate({}, editedPaths(jsonl, Date.parse(ts) + 1), deps())).ok).toBe(true);
    expect((await evaluateDoneGate({}, editedPaths(tool("Read", { file_path: `${M}/ui/page.ts` }), 1), deps())).ok).toBe(true);
  });

  it("does not interpret malformed or incomplete mutation records as no edits", async () => {
    for (const jsonl of ["", "{", "null", tool("Write", {}), tool("Read", {}) + "\n{"]) {
      expect(await evaluateDoneGate({}, editedPaths(jsonl, 1), deps())).toMatchObject({ ok: false, evidence: "unknown" });
    }
  });

  it("requires evidence for all F01 variants against a real dirty checkout and alias", async () => {
    // Retained NVM scratch is offline evidence; never touches the live checkout.
    const scratch = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco973-gate-");
    await fs.writeFile(path.join(scratch, "RETENTION.md"), "SCO-973 offline Git/transcript fixture. Preserve as regression evidence; archive this group with the issue evidence during scratch curation. No owner files or live checkout edits.\n");
    const repo = path.join(scratch, "master");
    const alias = path.join(scratch, "src");
    await fs.mkdir(path.join(repo, "ui"), { recursive: true });
    const file = path.join(repo, "ui/page.ts");
    await fs.writeFile(file, "before\n");
    await fs.symlink(repo, alias);
    const run = promisify(execFile);
    const git = async (args: string[]) => {
      try {
        const { stdout } = await run("/usr/bin/git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
        return { code: 0, out: stdout };
      } catch (e) { return { code: Number((e as { code: number }).code) || 1, out: "" }; }
    };
    expect((await git(["init", "-q"])).code).toBe(0);
    expect((await git(["add", "ui/page.ts"])).code).toBe(0);
    expect((await git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"])).code).toBe(0);
    await fs.writeFile(file, "unfinished\n");
    const realDeps: GateDeps = { repos: async () => [repo], git: async (_repo, args) => git(args), liveSha: async () => null };
    const transcript = path.join(scratch, "run.jsonl");
    for (const record of [tool("Bash", { command: "shell edit" }, alias), tool("Edit", { file_path: "ui/page.ts" }, alias), tool("Write", { file_path: path.join(alias, "ui/page.ts") })]) {
      await fs.writeFile(transcript, record);
      expect((await gateReceiptRaw("{}", transcript, 1, realDeps)).ok).toBe(false);
    }
    // A deleted target still resolves through its aliased parent.
    const deleted = editedPaths(tool("Edit", { file_path: path.join(alias, "ui/deleted.ts") }), 1);
    expect((await evaluateDoneGate({}, deleted, realDeps)).ok).toBe(false);
    await fs.writeFile(transcript, tool("Read", { file_path: file }));
    expect((await gateReceiptRaw("{}", transcript, 1, realDeps)).ok).toBe(true);
    const commit = (await git(["rev-parse", "HEAD"])).out.trim();
    await fs.writeFile(file, "before\n");
    await fs.writeFile(transcript, tool("Edit", { file_path: "ui/page.ts" }, alias));
    expect((await gateReceiptRaw(JSON.stringify({ commits: [commit] }), transcript, 1, realDeps)).ok).toBe(true);
  });
});

describe("done gate", () => {
  it("passes when no canonical repo was touched", async () => {
    expect((await evaluateDoneGate({}, ["/tmp/x"], deps())).ok).toBe(true);
  });
  it("refuses a receipt with no SHA after a canonical edit", async () => {
    const v = await evaluateDoneGate({}, [`${M}/server/a.ts`], deps());
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reasons.join()).toContain("no commits");
  });
  it("returns own uncommitted edits to the worker", async () => {
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], deps({ dirty: " M server/a.ts\0" }));
    expect(!v.ok && v.reasons[0]).toContain("uncommitted edits of this run");
  });
  it("accepts notMine for dirt that is another agent's", async () => {
    const v = await evaluateDoneGate({ commits: [sha1], notMine: ["server/a.ts"] }, [`${M}/server/a.ts`], deps({ dirty: " M server/a.ts\0" }));
    expect(v.ok).toBe(true);
  });
  it("refuses a SHA that is not on HEAD or in no checkout", async () => {
    expect((await evaluateDoneGate({ commits: [sha1] }, [`${M}/a.ts`], deps({ onHead: new Set() }))).ok).toBe(false);
    expect((await evaluateDoneGate({ commits: [sha1] }, [`${M}/a.ts`], deps({ known: { [sha1]: "/elsewhere" } }))).ok).toBe(false);
  });
  it("accepts a Paperclip SHA that is queued, noting it", async () => {
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], deps());
    expect(v.ok && v.notes.join()).toContain("queued for autodeploy");
  });
  it("owner-visible UI must be live and carry a liveCheck", async () => {
    const ui = { uiFiles: "ui/public/subscription-quotas.html" };
    const queued = await evaluateDoneGate({ commits: [sha1] }, [`${M}/ui/public/x.html`], deps(ui));
    expect(!queued.ok && queued.reasons.join()).toContain("not live yet");
    const noCheck = await evaluateDoneGate({ commits: [sha1] }, [`${M}/ui/public/x.html`], deps({ ...ui, live: new Set([sha1]) }));
    expect(!noCheck.ok && noCheck.reasons.join()).toContain("liveCheck");
    const good = await evaluateDoneGate({ commits: [sha1], liveCheck: "curl -sk https://Scotts-Mac-Pro.local/x | rg -c Credits: before 1 after 0" }, [`${M}/ui/public/x.html`], deps({ ...ui, live: new Set([sha1]) }));
    expect(good.ok).toBe(true);
  });
  it("accepts a non-Paperclip SHA on its checkout", async () => {
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${Z}/go/a.go`], deps({ known: { [sha1]: Z } }));
    expect(v.ok).toBe(true);
  });
  it("maps a file to its deepest repo", () => {
    expect(repoOf(`${Z}/go/a.go`, [M, Z])).toBe(Z);
    expect(repoOf("/other/x", [M, Z])).toBeNull();
  });
});
