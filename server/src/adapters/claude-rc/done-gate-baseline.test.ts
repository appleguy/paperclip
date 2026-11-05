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
  const deps: GateDeps = { repos: async () => [repo], git, liveSha: async () => null };
  const baseline = await captureDoneGateBaseline("run", deps);
  const transcript = path.join(root, "transcript.jsonl");
  const check = (commits: string[], notMine = ["peer.ts"], start = baseline) => gateReceiptRaw(JSON.stringify({ runId: "run", commits, notMine }), transcript, 100, deps, start);
  for (const name of ["Bash", "Agent", "Skill", "mcp__tool"]) {
    await fs.writeFile(transcript, JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", message: { content: [{ type: "tool_use", name, input: {} }] } }));
    // Captured preexisting dirt can be excluded, even for read-only shell work.
    expect((await check([])).ok).toBe(true);
    expect(await gateReceiptRaw('{"runId":"run"}', transcript, 100, deps)).toMatchObject({ ok: false, evidence: "unknown" });
  }
  await fs.writeFile(path.join(repo, "own.ts"), "shell mutation\n");
  expect((await check([old], ["peer.ts", "own.ts"])).ok).toBe(false);
  expect((await check([])).ok).toBe(false);
  const own = await commit();
  expect((await check([own])).ok).toBe(true);
  expect(await check([own], ["peer.ts"], { ...baseline, repos: [] })).toMatchObject({ ok: false, evidence: "unknown" });
  expect((await check([old])).ok).toBe(false);
  expect((await check([own], [])).ok).toBe(false);
  const legacy = { ...baseline, repos: baseline.repos.map(({ repo, head }) => ({ repo, head })) };
  expect((await check([own], ["peer.ts"], legacy)).ok).toBe(false);
  await fs.writeFile(path.join(repo, "own.ts"), "uncommitted after valid commit\n");
  expect((await check([own], ["peer.ts", "own.ts"])).ok).toBe(false);
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
