import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { editedPaths, gateReceiptRaw, type GateDeps } from "./done-gate.js";
import { captureDoneGateBaseline } from "./done-gate-provenance.js";

it("settles shell, agent and MCP writes from dispatch Git evidence and rejects dirty shell edits", async () => {
  const root = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1003-gate-");
  await fs.writeFile(path.join(root, "RETENTION.md"), "SCO-1003 isolated Git evidence. Archive text with issue evidence during scratch curation. No live repo mutations.\n");
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const run = promisify(execFile);
  const git: GateDeps["git"] = async (cwd, args) => {
    try {
      const { stdout } = await run("/usr/bin/git", ["-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      return { code: 0, out: stdout.replace(/\n+$/, "") };
    } catch (error) { return { code: Number((error as { code: number }).code) || 1, out: "" }; }
  };
  const commit = async () => {
    expect((await git(repo, ["add", "own.ts"])).code).toBe(0);
    expect((await git(repo, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"])).code).toBe(0);
    return (await git(repo, ["rev-parse", "HEAD"])).out;
  };
  expect((await git(repo, ["init", "-q"])).code).toBe(0);
  await fs.writeFile(path.join(repo, "own.ts"), "before\n");
  const old = await commit();
  await fs.writeFile(path.join(repo, "peer.ts"), "preexisting dirt\n");
  const unborn = path.join(root, "unborn");
  await fs.mkdir(unborn);
  expect((await git(unborn, ["init", "-q"])).code).toBe(0);
  const deps: GateDeps = { repos: async () => [repo, unborn], git, liveSha: async () => null };
  const baseline = await captureDoneGateBaseline("run", deps);
  expect(baseline.repos.map(start => start.repo)).toEqual([repo]);
  const transcript = path.join(root, "transcript.jsonl");
  const check = (commits: string[], notMine = ["peer.ts"], start = baseline) => gateReceiptRaw(JSON.stringify({ runId: "run", commits, notMine }), transcript, 100, deps, start);
  for (const name of ["Bash", "Agent", "Skill", "mcp__tool"]) {
    await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name, input: {} }] } }));
    // Captured preexisting dirt can be excluded, even for read-only shell work.
    expect((await check([])).ok).toBe(true);
    // SCO-1111: without a baseline an unknown write set is a warning, not a refusal.
    expect(await gateReceiptRaw('{"runId":"run"}', transcript, 100, deps)).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("write set partly unknown")]) });
  }
  await fs.writeFile(path.join(repo, "own.ts"), "shell mutation\n");
  // An input-checkable tool that names nothing leaves the change unattributed (SCO-1003).
  expect(await check([])).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("own.ts")]) });
  // SCO-1111: a nested agent whose input names nothing leaves the change unattributed;
  // one that names the file owns it.
  await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name: "Agent", input: {} }] } }));
  expect(await check([])).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("own.ts")]) });
  await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name: "Agent", input: { target: path.join(repo, "own.ts") } }] } }));
  expect((await check([old], ["peer.ts"])).ok).toBe(false);
  expect((await check([])).ok).toBe(false);
  const own = await commit();
  expect((await check([own])).ok).toBe(true);
  const failedHead: GateDeps = { ...deps, git: async (cwd, args) => cwd === unborn
    ? { code: 1, out: "", error: "Git unavailable" } : git(cwd, args) };
  expect(await gateReceiptRaw('{"runId":"run"}', transcript, 100, failedHead, baseline))
    .toMatchObject({ ok: false, evidence: "unknown" });
  expect((await git(unborn, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-qm", "first commit after dispatch"])).code).toBe(0);
  expect(await check([own])).toMatchObject({ ok: false, evidence: "unknown",
    reasons: [expect.stringContaining(`dispatch baseline unavailable for repository ${unborn}`)] });
  // Keep subsequent negative controls scoped to the original repository.
  deps.repos = async () => [repo];
  baseline.unbornRepos = [];
  expect(await check([own], ["peer.ts"], { ...baseline, repos: [] })).toMatchObject({ ok: false, evidence: "unknown" });
  expect((await check([old])).ok).toBe(false);
  expect((await check([own], [])).ok).toBe(true); // unchanged dirt is fingerprinted
  const legacy = { ...baseline, repos: baseline.repos.map(({ repo, head }) => ({ repo, head })) };
  // SCO-1111: notMine is honored for a nested agent too; the receipt commit covers own.ts.
  expect((await check([own], ["peer.ts"], legacy)).ok).toBe(true);
  await fs.writeFile(path.join(repo, "own.ts"), "uncommitted after valid commit\n");
  // The receipt's notMine claim outranks an opaque writer, as for shell (SCO-1003); without it the change refuses.
  expect((await check([own], ["peer.ts", "own.ts"])).ok).toBe(true);
  expect((await check([own], ["peer.ts"])).ok).toBe(false);
  // Baseline dirt exemptions never override an explicit tool mutation.
  await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", cwd: repo, message: { content: [
    { type: "tool_use", name: "Bash", input: {} },
    { type: "tool_use", name: "Write", input: { file_path: "peer.ts" } },
  ] } }));
  expect((await check([own])).ok).toBe(false);
  const failed: GateDeps = { ...deps, git: async (cwd, args) => args[0] === "diff" ? { code: 128, out: "" } : git(cwd, args) };
  expect(await gateReceiptRaw('{"runId":"run"}', transcript, 100, failed, baseline)).toMatchObject({ ok: false, evidence: "unknown" });
});

it("skips untimestamped historical tools before the first run record and retains later uncertainty", () => {
  const tool = { message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } };
  const start = { timestamp: "2026-11-05T02:00:00Z", message: { content: [] } };
  const since = Date.parse(start.timestamp);
  expect(editedPaths([tool, start].map(x => JSON.stringify(x)).join("\n"), since)).toEqual({ paths: [], unknown: [] });
  expect(editedPaths([start, tool].map(x => JSON.stringify(x)).join("\n"), since).unknown).toContain("tool record has no run timestamp");
});
