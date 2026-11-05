import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { GateDeps } from "./done-gate.js";
import { gateReceiptRaw } from "./done-gate.js";
import { captureDoneGateBaseline, validateCompletionProvenance } from "./done-gate-provenance.js";

it("binds completion to the run, repository, changed paths and current content (S7 F03)", async () => {
  const scratch = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco975-provenance-");
  await fs.writeFile(path.join(scratch, "RETENTION.md"), "SCO-975 isolated Git fixtures. Preserve text evidence; archive with issue evidence during NVM scratch curation. No live checkout mutations.\n");
  const run = promisify(execFile);
  const git: GateDeps["git"] = async (repo, args) => {
    try {
      const { stdout } = await run("/usr/bin/git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      return { code: 0, out: stdout.trimEnd() };
    } catch (error) { return { code: Number((error as { code: number }).code) || 1, out: "" }; }
  };
  const repo = path.join(scratch, "master"), other = path.join(scratch, "other");
  const commit = async (root: string, message: string) => {
    expect((await git(root, ["add", "."])).code).toBe(0);
    expect((await git(root, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message])).code).toBe(0);
    return (await git(root, ["rev-parse", "HEAD"])).out.trim();
  };
  for (const root of [repo, other]) {
    await fs.mkdir(path.join(root, "ui"), { recursive: true });
    expect((await git(root, ["init", "-q"])).code).toBe(0);
    await fs.writeFile(path.join(root, "ui/page.ts"), "before\n");
    await fs.writeFile(path.join(root, "server.ts"), root + "\n");
    await commit(root, "initial");
  }
  await fs.writeFile(path.join(repo, "server.ts"), "old server commit\n");
  const old = await commit(repo, "older server only");
  const deps: GateDeps = { repos: async () => [repo, other], git, liveSha: async () => null };
  const baseline = await captureDoneGateBaseline("fixture-run", deps);
  const touched = new Map([[repo, [path.join(repo, "ui/page.ts")]]]);
  const check = (commits: string[], notMine?: string[]) => validateCompletionProvenance({ runId: "fixture-run", commits, notMine }, touched, deps, baseline);
  const transcript = path.join(scratch, "run.jsonl");
  await fs.writeFile(transcript, JSON.stringify({ timestamp: new Date().toISOString(), cwd: repo, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "ui/page.ts" } }] } }));
  const gate = (commits: string[], notMine?: string[]) => gateReceiptRaw(JSON.stringify({ runId: "fixture-run", commits, notMine }), transcript, 1, deps, baseline);
  await fs.writeFile(path.join(repo, "ui/page.ts"), "unfinished\n");
  const f03 = await check([old], ["ui/page.ts"]);
  expect(f03.ok).toBe(false);
  expect(!f03.ok && f03.reasons.join()).toContain("notMine cannot exempt");
  expect((await gate([old], ["ui/page.ts"])).ok).toBe(false);
  expect((await git(repo, ["status", "--porcelain"])).out).toContain("ui/page.ts");
  await fs.writeFile(path.join(other, "ui/page.ts"), "other repo change\n");
  const wrongRepo = await commit(other, "wrong repo");
  expect((await check([wrongRepo], ["ui/page.ts"])).ok).toBe(false);
  expect((await gate([wrongRepo], ["ui/page.ts"])).ok).toBe(false);
  const own = await commit(repo, "run UI change");
  expect((await check([old])).ok).toBe(false);
  expect((await check([own])).ok).toBe(true);
  expect((await gate([own])).ok).toBe(true);
  expect(await validateCompletionProvenance({ commits: [own] }, touched, deps)).toMatchObject({ ok: false, evidence: "unknown" });
  expect(await validateCompletionProvenance({ runId: "another-run", commits: [own] }, touched, deps, baseline)).toMatchObject({ ok: false, evidence: "unknown" });
  // Unrelated concurrent worker dirt is preserved without any claimant exemption.
  await fs.writeFile(path.join(repo, "server.ts"), "concurrent work\n");
  expect((await check([own])).ok).toBe(true);
  expect((await git(repo, ["status", "--porcelain"])).out).toContain("server.ts");
  await fs.writeFile(path.join(repo, "ui/page.ts"), "subsequent content\n");
  const later = await commit(repo, "later UI content");
  expect((await check([own])).ok).toBe(false);
  expect((await check([later])).ok).toBe(true);
  expect((await check([own, later])).ok).toBe(true);
  await fs.unlink(path.join(repo, "ui/page.ts"));
  const deletion = await commit(repo, "delete page");
  expect((await check([deletion])).ok).toBe(true);
  const failedDeps: GateDeps = { ...deps, git: async (root, args) => args[0] === "diff" ? { code: 128, out: "" } : git(root, args) };
  expect(await validateCompletionProvenance({ runId: "fixture-run", commits: [deletion] }, touched, failedDeps, baseline)).toMatchObject({ ok: false, evidence: "unknown" });
  expect((await validateCompletionProvenance({}, new Map(), deps)).ok).toBe(true);
});
