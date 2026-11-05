import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { editedPaths, evaluateDoneGate, type GateDeps } from "./done-gate.js";
import { captureDoneGateBaseline } from "./done-gate-provenance.js";

it("finishes the slot proof amid peer commits and dirty paths, but refuses own writes", async () => {
  const repo = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1003-concurrent-");
  await fs.writeFile(path.join(repo, "RETENTION.md"), "Gate regression evidence. Preserve text through NVM scratch archival curation.\n");
  const run = promisify(execFile);
  const git: GateDeps["git"] = async (cwd, args) => {
    try {
      const { stdout } = await run("/usr/bin/git", ["-C", cwd, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      return { code: 0, out: stdout };
    } catch (error) { return { code: Number((error as { code: number }).code) || 1, out: "" }; }
  };
  const commit = async () => {
    expect((await git(repo, ["add", "."])).code).toBe(0);
    expect((await git(repo, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"])).code).toBe(0);
  };
  await git(repo, ["init", "-q"]);
  await fs.writeFile(path.join(repo, "peer.ts"), "original\n");
  await commit();
  const deps: GateDeps = { repos: async () => [repo], git, liveSha: async () => null };
  const baseline = await captureDoneGateBaseline("run", deps);
  await fs.writeFile(path.join(repo, "peer.ts"), "peer commit\n");
  await commit();
  // Both newly dirty paths and changed preexisting files belong to peers.
  const peers = ["execute.ts", "execute.busy.test.ts", "queue-drive.ts", "recovery.ts", "peer.ts"];
  for (const file of peers) await fs.writeFile(path.join(repo, file), "concurrent uncommitted work\n");
  const tool = (name: string, input: object) => JSON.stringify({
    timestamp: "2026-11-05T02:00:00Z", cwd: repo, message: { content: [{ type: "tool_use", name, input }] },
  });
  const transcript = [tool("Bash", { command: 'sleep 120; echo "TMUX=$TMUX"' }),
    tool("Write", { file_path: path.join(path.dirname(repo), "runtime-receipt.json") }),
    tool("mcp__pcbridge__paperclip_finish", { op_id: "run" })].join("\n");
  const record = editedPaths(transcript, 1);
  expect(record.unknown).toEqual([]);
  expect(await evaluateDoneGate({ runId: "run" }, record, deps, baseline)).toMatchObject({ ok: true });
  // Prose, notMine and a nonmutating command never hide an explicit own write.
  const own = editedPaths(transcript + "\n" + tool("Write", { file_path: "peer.ts" }), 1);
  expect(await evaluateDoneGate({ runId: "run", notMine: peers }, own, deps, baseline))
    .toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringContaining("notMine cannot exempt")]) });
  // Opaque reads of peers' files leave their dirt unattributed: noted, not refused.
  const reads = editedPaths(transcript + "\n" + tool("Bash", { command: "git diff -- execute.ts peer.ts 2>&1 | head; rg -n 'a|b' queue-drive.ts" }), 1);
  const read = await evaluateDoneGate({ runId: "run" }, reads, deps, baseline);
  expect(read).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("not attributed to this run")]) });
  // An opaque command that writes a dirty path claims it until committed or disowned.
  for (const command of ["echo hidden > peer.ts", "sed -i '' s/a/b/ peer.ts", "echo $(touch peer.ts)", "cd sub && perl -pi -e s/a/b/ ../peer.ts"]) {
    const shell = editedPaths(tool("Bash", { command }), 1);
    const verdict = await evaluateDoneGate({ runId: "run" }, shell, deps, baseline);
    expect(verdict, command).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringContaining("tools may have written")]) });
    expect(JSON.stringify(verdict)).not.toContain("independently recorded run mutations");
    expect(await evaluateDoneGate({ runId: "run", notMine: ["peer.ts"] }, shell, deps, baseline), command).toMatchObject({ ok: true });
  }
});
