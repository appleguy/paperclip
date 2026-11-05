import { describe, expect, it } from "vitest";
import { editedPaths, evaluateDoneGate, repoOf, type GateDeps } from "./done-gate.js";

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
    expect(editedPaths(jsonl, Date.parse("2026-11-05T01:30:00Z"))).toEqual([`${M}/new.ts`]);
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
