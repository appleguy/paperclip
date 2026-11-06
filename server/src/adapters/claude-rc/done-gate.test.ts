import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { editedPaths, evaluateDoneGate as evaluate, gateReceiptRaw, productionDeps, repoOf, type GateDeps, type GateReceipt, type MutationRecord } from "./done-gate.js";
import { captureDoneGateBaseline } from "./done-gate-provenance.js";
import { statusPaths } from "./done-gate-worktree.js";

const M = "/Volumes/NVM/Paperclip/master";
const Z = "/Volumes/NVM/AI_Coding_Projects/zagent";
const LIVE = "a".repeat(40);
const BASE = "c".repeat(40);
const evaluateDoneGate = (receipt: GateReceipt, paths: string[] | MutationRecord, d: GateDeps) =>
  evaluate({ runId: "test-run", ...receipt }, paths, d, { runId: "test-run", repos: [M, Z].map(repo => ({ repo, head: BASE })) });

function deps(over: { dirty?: string; known?: Record<string, string>; onHead?: Set<string>; live?: Set<string>; uiFiles?: string } = {}): GateDeps {
  return {
    repos: async () => [M, Z],
    liveSha: async () => LIVE,
    git: async (repo, args) => {
      if (args[0] === "status") return { code: 0, out: over.dirty ?? "" };
      const changed = "server/a.ts\0ui/public/x.html\0go/a.go\0a.ts\0";
      if (args[0] === "diff-tree") return { code: 0, out: changed };
      if (args[0] === "diff") return { code: 0, out: args.includes(BASE) ? changed : "" };
      const sha = (args.find(a => /^[0-9a-f]{7,40}(\^\{commit\})?$/i.test(a)) ?? "").replace("^{commit}", "");
      if (args[0] === "cat-file") return { code: (over.known?.[sha] ?? M) === repo ? 0 : 1, out: "" };
      if (args[0] === "merge-base") {
        const target = args[args.length - 1];
        if (target === BASE) return { code: 1, out: "" };
        if (args[2] === BASE) return { code: 0, out: "" };
        const ok = target === LIVE ? (over.live ?? new Set()).has(sha) : (over.onHead ?? new Set([sha])).has(sha);
        return { code: ok ? 0 : 1, out: "" };
      }
      if (args[0] === "show") return { code: 0, out: over.uiFiles ?? "server/src/x.ts" };
      return { code: 1, out: "" };
    },
  };
}
const sha1 = "b".repeat(40);

describe("unavailable evidence (SCO-974 / S7 F02)", () => {
  it("distinguishes an absent path, missing file, denied read, and readable empty file", async () => {
    expect(await gateReceiptRaw("{}", null, 1, deps())).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("no transcript path")] });
    const scratch = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco974-gate-");
    await fs.writeFile(path.join(scratch, "RETENTION.md"), "SCO-974 offline transcript fixtures. Preserve text evidence; archive with issue evidence during scratch curation. No live checkout or owner records changed.\n");
    const transcript = path.join(scratch, "run.jsonl");
    expect(await gateReceiptRaw("{}", transcript, 1, deps())).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("ENOENT")] });
    // Deterministic denied read, independent of root/ACL permissions on the host.
    const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      expect(await gateReceiptRaw("{}", transcript, 1, deps())).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("EACCES")] });
    } finally { read.mockRestore(); }
    await fs.writeFile(transcript, "");
    expect(await gateReceiptRaw("{}", transcript, 1, deps())).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("read successfully but is empty")] });
    // No-code work is established by actual readable run records, not a
    // worker's assertion that missing/empty evidence means nothing changed.
    await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "text", text: "No tool work required." }] } }));
    expect(await gateReceiptRaw("{}", transcript, 1, deps())).toMatchObject({ ok: true });
  });

  it.each(["null", "[]", "1"])("refuses a non-object receipt %s without throwing", async raw => {
    expect(await gateReceiptRaw(raw, null, 1, deps())).toMatchObject({ ok: false, reasons: ["receipt must be a JSON object"] });
  });

  it.each([
    { code: 128, out: "" },
    { code: 128, out: " M server/a.ts\0" },
    { code: 124, out: "", error: "timed out" },
  ])("keeps failed status unknown with a valid prior commit: %j", async status => {
    const base = deps();
    const v = await evaluateDoneGate({ commits: [sha1], notMine: ["server/a.ts"] }, [`${M}/server/a.ts`], {
      ...base, git: async (repo, args) => args[0] === "status" ? status : base.git(repo, args),
    });
    expect(v).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("git status")] });
  });

  it("converts a thrown status timeout into an actionable unknown verdict", async () => {
    const base = deps();
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], {
      ...base, git: async (repo, args) => {
        if (args[0] === "status") throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
        return base.git(repo, args);
      },
    });
    expect(v).toMatchObject({ ok: false, evidence: "unknown", reasons: [expect.stringContaining("timed out or killed")] });
  });

  it("preserves a real Git failure through the production subprocess boundary", async () => {
    const base = deps();
    // /dev/null cannot be a checkout; Git exits nonzero with empty stdout.
    const result = await productionDeps().git("/dev/null", ["status", "--porcelain=v1", "-z"]);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
    expect(await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], {
      ...base, git: async (repo, args) => args[0] === "status" ? result : base.git(repo, args),
    })).toMatchObject({ ok: false, evidence: "unknown" });
  });

  it.each(["show", "merge-base"])("does not consume failed %s output as positive evidence", async command => {
    const base = deps();
    expect(await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], {
      ...base, git: async (repo, args) => args[0] === command ? { code: 128, out: "" } : base.git(repo, args),
    })).toMatchObject({ ok: false, evidence: "unknown" });
  });
});

describe("editedPaths", () => {
  it("collects Edit/Write targets at or after the run start", () => {
    const line = (ts: string, name: string, p: string) => JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", name, input: { file_path: p } }] } });
    const jsonl = [line("2026-11-05T01:00:00Z", "Edit", `${M}/old.ts`), line("2026-11-05T02:00:00Z", "Write", `${M}/new.ts`), line("2026-11-05T02:01:00Z", "Read", `${M}/r.ts`)].join("\n");
    expect(editedPaths(jsonl, Date.parse("2026-11-05T01:30:00Z"))).toEqual({ paths: [`${M}/new.ts`], unknown: [] });
  });
  it("ignores tool blocks copied into api-request-blob records (SCO-1107)", () => {
    const blob = JSON.stringify({ type: "api-request-blob", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${M}/copied.ts` } }] } });
    const own = JSON.stringify({ type: "assistant", timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: `${M}/mine.ts` } }] } });
    expect(editedPaths([blob, own].join("\n"), Date.parse("2026-11-05T01:30:00Z"))).toEqual({ paths: [`${M}/mine.ts`], unknown: [] });
  });
  it("preserves uncertainty about untimestamped tools instead of assuming replay", () => {
    const replay = JSON.stringify({ message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${M}/replayed.ts` } }] } });
    expect(editedPaths(replay, Date.parse("2026-11-05T01:30:00Z")).unknown).toContain("tool record has no run timestamp");
    expect(editedPaths(replay, 0)).toEqual({ paths: [`${M}/replayed.ts`], unknown: [] });
  });

  it("preserves NotebookEdit and MultiEdit targets with spaces and non-ASCII characters", () => {
    const notebook = `${M}/notebooks/研究 notes/café.ipynb`;
    const multiEdit = `${M}/server/naïve path/page.ts`;
    const jsonl = [
      JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: notebook } }] } }),
      JSON.stringify({ timestamp: "2026-11-05T02:01:00Z", message: { content: [{ type: "tool_use", name: "MultiEdit", input: { file_path: multiEdit, edits: [] } }] } }),
    ].join("\n");
    expect(editedPaths(jsonl, Date.parse("2026-11-05T01:30:00Z"))).toEqual({ paths: [notebook, multiEdit], unknown: [] });
  });

  it("keeps mixed timestamped and untimestamped records on the right side of run start", () => {
    const untimestamped = (p: string) => JSON.stringify({ message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: p } }] } });
    const timestamped = (ts: string, p: string) => JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: p } }] } });
    const jsonl = [
      untimestamped(`${M}/replayed.ts`),
      timestamped("2026-11-05T01:00:00Z", `${M}/before.ts`),
      timestamped("2026-11-05T02:00:00Z", `${M}/during.ts`),
      untimestamped(`${M}/ambiguous.ts`),
    ].join("\n");
    expect(editedPaths(jsonl, Date.parse("2026-11-05T01:30:00Z"))).toEqual({
      paths: [`${M}/during.ts`],
      unknown: ["tool record has no run timestamp"],
    });
  });
});

describe("run mutation attribution (SCO-973 / S7 F01)", () => {
  const ts = "2026-11-05T02:00:00Z";
  const tool = (name: string, input: unknown, cwd?: string) => JSON.stringify({ timestamp: ts, cwd, message: { content: [{ type: "tool_use", name, input }] } });

  it("returns unknown for shell and unrecognized tool write sets, even with commit prose", async () => {
    for (const name of ["Bash", "mcp__shell", "Agent"]) {
      const record = editedPaths(tool(name, { command: "sed -i '' s/a/b/ ui/page.ts" }), 1);
      const v = await evaluate({ commits: [sha1] }, record, deps());
      expect(v).toMatchObject({ ok: false, evidence: "unknown" });
    }
  });

  it("resolves relative targets from the transcript cwd or preserves unknown", async () => {
    const resolved = editedPaths(tool("Edit", { file_path: "ui/page.ts" }, M), 1);
    expect(resolved).toEqual({ paths: [`${M}/ui/page.ts`], unknown: [] });
    expect((await evaluateDoneGate({}, resolved, deps())).ok).toBe(false);
    const unresolved = editedPaths(tool("Edit", { file_path: "ui/page.ts" }), 1);
    expect(await evaluate({}, unresolved, deps())).toMatchObject({ ok: false, evidence: "unknown" });
  });

  it("permits normal read-only work and excludes earlier timestamped mutations", async () => {
    const jsonl = [tool("Bash", { command: "edit" }), tool("Read", { file_path: `${M}/ui/page.ts` }), tool("Grep", { pattern: "x" }), tool("Glob", { pattern: "**/*" })].join("\n");
    expect((await evaluateDoneGate({}, editedPaths(jsonl, Date.parse(ts) + 1), deps())).ok).toBe(true);
    expect((await evaluateDoneGate({}, editedPaths(tool("Read", { file_path: `${M}/ui/page.ts` }), 1), deps())).ok).toBe(true);
  });

  it("does not interpret malformed or incomplete mutation records as no edits", async () => {
    for (const jsonl of ["", "{", "null", tool("Write", {}), tool("Read", {}) + "\n{"]) {
      expect(await evaluate({}, editedPaths(jsonl, 1), deps())).toMatchObject({ ok: false, evidence: "unknown" });
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
    const baseline = await captureDoneGateBaseline("fixture-run", realDeps);
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
    await fs.writeFile(file, "committed run change\n");
    expect((await git(["add", "ui/page.ts"])).code).toBe(0);
    expect((await git(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "run change"])).code).toBe(0);
    const commit = (await git(["rev-parse", "HEAD"])).out.trim();
    await fs.writeFile(transcript, tool("Edit", { file_path: "ui/page.ts" }, alias));
    expect((await gateReceiptRaw(JSON.stringify({ runId: "fixture-run", commits: [commit] }), transcript, 1, realDeps, baseline)).ok).toBe(true);
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
  it("keeps both unquoted paths from a porcelain-v1 rename record", () => {
    expect(statusPaths("R  server/new name/新.ts\0server/old name/旧.ts\0")).toEqual([
      "server/new name/新.ts",
      "server/old name/旧.ts",
    ]);
  });
  it("rejects notMine for a path independently recorded as this run's mutation", async () => {
    const v = await evaluateDoneGate({ commits: [sha1], notMine: ["server/a.ts"] }, [`${M}/server/a.ts`], deps({ dirty: " M server/a.ts\0" }));
    expect(v.ok).toBe(false);
  });
  it("refuses a SHA that is not on HEAD or in no checkout", async () => {
    expect((await evaluateDoneGate({ commits: [sha1] }, [`${M}/a.ts`], deps({ onHead: new Set() }))).ok).toBe(false);
    expect((await evaluateDoneGate({ commits: [sha1] }, [`${M}/a.ts`], deps({ known: { [sha1]: "/elsewhere" } }))).ok).toBe(false);
  });
  it("accepts a Paperclip SHA that is queued, noting it", async () => {
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${M}/server/a.ts`], deps());
    expect(v.ok && v.notes.join()).toContain("queued for autodeploy");
  });
  it("accepts a seven-character uppercase commit SHA", async () => {
    const shortUpper = sha1.slice(0, 7).toUpperCase();
    const v = await evaluateDoneGate({ commits: [shortUpper] }, [`${M}/server/a.ts`], deps({ onHead: new Set([shortUpper]) }));
    expect(v.ok).toBe(true);
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
  it("uses the first checkout when a SHA exists in more than one repo", async () => {
    const base = deps();
    const both = {
      ...base,
      git: async (repo: string, args: string[]) => {
        if (args[0] === "cat-file") return { code: 0, out: "" };
        if (args[0] === "merge-base") return { code: args[2] === sha1 && args[3] === BASE ? 1 : 0, out: "" };
        if (args[0] === "diff") return { code: 0, out: args.includes(BASE) ? "go/a.go\0" : "" };
        if (args[0] === "diff-tree") return { code: 0, out: "go/a.go\0" };
        return base.git(repo, args);
      },
    } satisfies GateDeps;
    const v = await evaluateDoneGate({ commits: [sha1] }, [`${Z}/go/a.go`], both);
    expect(v.ok).toBe(true);
    expect(v.notes.join()).toContain("live");
    expect(v.notes.join()).not.toContain(`on ${Z}`);
  });
  it("maps a file to its deepest repo", () => {
    expect(repoOf(`${Z}/go/a.go`, [M, Z])).toBe(Z);
    expect(repoOf("/other/x", [M, Z])).toBeNull();
  });
});
