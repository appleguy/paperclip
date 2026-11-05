import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { editedPaths, evaluateDoneGate, type GateDeps } from "./done-gate.js";
import { captureDoneGateBaseline } from "./done-gate-provenance.js";

it("separates concurrent commits, unchanged dirt, changed baseline dirt and omitted own commits", async () => {
  const repo = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1003-shared-");
  await fs.writeFile(path.join(repo, "RETENTION.md"), "Isolated gate regression. Archive text with issue evidence during scratch curation.\n");
  const run = promisify(execFile);
  const git: GateDeps["git"] = async (cwd, args) => {
    try {
      const { stdout } = await run("/usr/bin/git", ["-C", cwd, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      return { code: 0, out: stdout };
    } catch (error) { return { code: Number((error as { code: number }).code) || 1, out: "" }; }
  };
  const commit = async (file: string, content: string, root = repo) => {
    await fs.writeFile(path.join(root, file), content);
    expect((await git(root, ["add", "--", file])).code).toBe(0);
    expect((await git(root, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"])).code).toBe(0);
    return (await git(root, ["rev-parse", "HEAD"])).out.trim();
  };
  expect((await git(repo, ["init", "-q"])).code).toBe(0);
  await commit("own.ts", "initial\n");
  await commit("peer.ts", "initial\n");
  await fs.writeFile(path.join(repo, "old-dirt"), "original\n");
  const nested = path.join(repo, "nested");
  await fs.mkdir(nested);
  await git(nested, ["init", "-q"]);
  await commit("file.ts", "nested original\n", nested);
  const deps: GateDeps = { repos: async () => [repo], git, liveSha: async () => null };
  const baseline = await captureDoneGateBaseline("run", deps);
  const own = await commit("own.ts", "own committed change\n");
  await commit("peer.ts", "concurrent committed change\n");
  const transcript = [
    { message: { content: [{ type: "tool_use", id: "commit", name: "Bash", input: { command: "git commit -m fixture" } }] } },
    { message: { content: [{ type: "tool_result", tool_use_id: "commit", content: `[main ${own.slice(0, 7)}] fixture\n 1 file changed` }] } },
  ].map(row => JSON.stringify({ timestamp: "2026-11-05T02:00:00Z", ...row })).join("\n");
  const record = editedPaths(transcript, 1);
  expect(record.observedCommits).toEqual([own.slice(0, 7)]);
  expect(editedPaths(transcript.replace("git commit -m fixture", "git commit -qm fixture && git log --oneline -1")
    .replace(`[main ${own.slice(0, 7)}] fixture`, `${own.slice(0, 7)} fixture`), 1).observedCommits).toEqual([own.slice(0, 7)]);
  // A nested agent's writes are unrecorded: every dispatch delta stays this run's.
  const unrecorded = editedPaths(transcript + "\n" + JSON.stringify({ timestamp: "2026-11-05T02:00:00Z",
    message: { content: [{ type: "tool_use", name: "Agent", input: {} }] } }), 1);
  const check = (commits = [own], notMine: string[] = []) => evaluateDoneGate({ runId: "run", commits, notMine }, unrecorded, deps, baseline);
  expect(await check()).toMatchObject({ ok: true });
  await fs.writeFile(path.join(nested, "file.ts"), "changed nested content\n");
  expect(await check()).toMatchObject({ ok: false });
  // SCO-1003: a shell command that names nothing does not claim a concurrent run's change.
  expect(await evaluateDoneGate({ runId: "run", commits: [own] }, record, deps, baseline))
    .toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("not attributed")]) });
  await fs.writeFile(path.join(nested, "file.ts"), "nested original\n");
  expect(await check()).toMatchObject({ ok: true });
  expect(await check([])).toMatchObject({ ok: false });
  // Changed existing dirt cannot be exempted with notMine in a new snapshot.
  await fs.writeFile(path.join(repo, "old-dirt"), "shell overwrote original\n");
  expect(await check([own], ["old-dirt"])).toMatchObject({ ok: false });
  await fs.writeFile(path.join(repo, "old-dirt"), "original\n");
  expect(await check()).toMatchObject({ ok: true });
  // Content equality alone is insufficient when a different blob is staged.
  await fs.writeFile(path.join(repo, "old-dirt"), "staged change\n");
  await git(repo, ["add", "old-dirt"]);
  await fs.writeFile(path.join(repo, "old-dirt"), "original\n");
  expect(await check()).toMatchObject({ ok: false });
  // Explicit recorded edits always win over the unchanged-dirt exemption.
  await git(repo, ["reset", "-q", "--", "old-dirt"]);
  expect(await evaluateDoneGate({ runId: "run", commits: [own] }, { ...record, paths: [path.join(repo, "old-dirt")] }, deps, baseline))
    .toMatchObject({ ok: false });
});

it("bounds Git argv and subprocess count with 52k paths and reports a bounded refusal", async () => {
  const repo = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1003-scale-");
  await fs.writeFile(path.join(repo, "RETENTION.md"), "Synthetic 52k path evidence; archive text with issue.\n");
  const base = "a".repeat(40), own = "b".repeat(40);
  const paths = Array.from({ length: 52_000 }, (_, i) => `nested/file-${i}.ts`);
  let calls = 0;
  const deps: GateDeps = {
    repos: async () => [repo], liveSha: async () => null,
    git: async (_repo, args) => {
      calls++;
      expect(args.join(" ").length).toBeLessThan(500);
      if (args[0] === "status") return { code: 0, out: ` M ${paths.at(-1)}\0` };
      if (args[0] === "merge-base") return { code: args.at(-1) === base ? 1 : 0, out: "" };
      if (args[0] === "cat-file") return { code: 0, out: "" };
      return { code: 0, out: args.includes(base) || args[0] === "diff-tree" ? paths.join("\0") + "\0" : "" };
    },
  };
  const verdict = await evaluateDoneGate({ runId: "run", commits: [own] }, paths.map(rel => path.join(repo, rel)), deps,
    { runId: "run", repos: [{ repo, head: base }] });
  expect(verdict).toMatchObject({ ok: false });
  expect(calls).toBeLessThan(20);
  expect(JSON.stringify(verdict).length).toBeLessThan(3000);
});
