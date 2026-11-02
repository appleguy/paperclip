import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreInstallOnly } from "./deploy-restore-install.mjs";

const SHA_NEW = "a".repeat(40);
const SHA_OLD = "b".repeat(40);
const SCRATCH = "/Volumes/NVM/AI_Agent_Runtime/tmp";

async function fixture() {
  const cliRoot = await fs.mkdtemp(path.join(SCRATCH, "pc-deploy-restore-fixture-"));
  const oldPath = path.join(cliRoot, "installs/git", SHA_OLD.slice(0, 12));
  const newPath = path.join(cliRoot, "installs/git", SHA_NEW.slice(0, 12));
  await fs.mkdir(oldPath, { recursive: true });
  await fs.mkdir(newPath, { recursive: true });
  const old = { source: "git", version: "0.1.0", channel: "pinned", payloadPath: oldPath,
    repo: "appleguy/paperclip", ref: SHA_OLD, sha: SHA_OLD, installedAt: "2026-11-02T01:00:00.000Z" };
  const newer = { ...old, payloadPath: newPath, ref: SHA_NEW, sha: SHA_NEW,
    installedAt: "2026-11-02T02:00:00.000Z" };
  await fs.writeFile(path.join(cliRoot, "install.json"),
    JSON.stringify({ schemaVersion: 1, ...newer, previous: [old] }));
  await fs.symlink(path.relative(cliRoot, newPath), path.join(cliRoot, "current"));
  return { cliRoot, old, newer,
    restore: () => restoreInstallOnly({ cliRoot, expectedShort: SHA_OLD.slice(0, 12),
      permittedFromShort: SHA_NEW.slice(0, 12) }),
    cleanup: () => fs.rm(cliRoot, { recursive: true, force: true }),
  };
}

describe("installer-state-only rollback cannot restart service", () => {
  it("atomically restores exact prior payload, rotates manifest, releases install lock", async () => {
    const f = await fixture();
    try {
      const answer = await f.restore();
      assert.equal(answer.restored, true);
      assert.equal(path.basename(await fs.readlink(path.join(f.cliRoot, "current"))), SHA_OLD.slice(0,12));
      const m = JSON.parse(await fs.readFile(path.join(f.cliRoot, "install.json"), "utf8"));
      assert.equal(m.sha, SHA_OLD);
      assert.equal(m.previous[0].sha, SHA_NEW);
      await assert.rejects(fs.access(path.join(f.cliRoot, ".install.lock")), /ENOENT/);
    } finally { await f.cleanup(); }
  });
  it("is idempotent if prior payload already selected", async () => {
    const f = await fixture();
    try {
      await f.restore();
      assert.equal((await f.restore()).restored, false);
    } finally { await f.cleanup(); }
  });
  it("refuses wrong original SHA without touching the current payload", async () => {
    const f = await fixture();
    try {
      await assert.rejects(restoreInstallOnly({ cliRoot: f.cliRoot,
        expectedShort: "c".repeat(12), permittedFromShort: SHA_NEW.slice(0, 12) }), /previous managed payload/);
      assert.equal(path.basename(await fs.readlink(path.join(f.cliRoot, "current"))), SHA_NEW.slice(0,12));
    } finally { await f.cleanup(); }
  });
  it("refuses another install writer and preserves its lock", async () => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.cliRoot, ".install.lock"), "123:test");
      await assert.rejects(f.restore(), /concurrently locked/);
      assert.equal(await fs.readFile(path.join(f.cliRoot, ".install.lock"), "utf8"), "123:test");
    } finally { await f.cleanup(); }
  });
  it("rejects an install-store payload redirect outside the managed tree", async () => {
    const f = await fixture();
    try {
      const mpath = path.join(f.cliRoot, "install.json");
      const m = JSON.parse(await fs.readFile(mpath, "utf8"));
      m.previous[0].payloadPath = path.join(os.tmpdir(), "untrusted");
      await fs.writeFile(mpath, JSON.stringify(m));
      await assert.rejects(f.restore(), /installer path escapes install store/);
    } finally { await f.cleanup(); }
  });
  it("never contains a command capable of restarting Paperclip", async () => {
    const source = await fs.readFile(new URL("./deploy-restore-install.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source.split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n"), /launchctl|kickstart|restartActiveManagedService|systemctl|pkill/);
  });
});
