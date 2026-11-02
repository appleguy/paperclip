#!/usr/bin/env node
// Installer-state-only rollback for a refused pre-kickstart deployment.
// Unlike Paperclip CLI update --rollback, NEVER restart the service.
// Mirrors rollbackManagedInstall and honors the existing .install.lock.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ensure = (ok, reason) => { if (!ok) throw new Error(reason); };
const sha40 = /^[a-f0-9]{40}$/;
async function tryUnlink(file) {
  try { await fs.unlink(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function readManifest(file) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  ensure(value?.schemaVersion === 1 && value?.source === "git" &&
    Array.isArray(value.previous) && sha40.test(value.sha),
    "unrecognized managed git installer manifest");
  return value;
}
async function safePayload(cliRoot, filename) {
  const base = path.join(cliRoot, "installs");
  const requested = path.resolve(filename);
  const rel = path.relative(base, requested);
  ensure(rel && !rel.startsWith("..") && !path.isAbsolute(rel),
    "managed installer path escapes install store");
  const [stat, real, realBase] = await Promise.all([
    fs.lstat(requested), fs.realpath(requested), fs.realpath(base),
  ]);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() &&
    real.startsWith(realBase + path.sep), "unsafe managed installer payload");
}
async function flip(cliRoot, target) {
  await safePayload(cliRoot, target);
  const dest = path.join(cliRoot, "current");
  ensure((await fs.lstat(dest)).isSymbolicLink(), "managed current is not a symlink");
  const temp = path.join(cliRoot, ".deploy-restore-" + process.pid + "-" + Date.now());
  try {
    await fs.symlink(path.relative(cliRoot, target), temp, "dir");
    await fs.rename(temp, dest);
  } finally { await tryUnlink(temp); }
}
export async function restoreInstallOnly({ cliRoot, expectedShort, permittedFromShort }) {
  ensure(typeof cliRoot === "string" && path.isAbsolute(cliRoot),
    "absolute managed CLI root required");
  ensure(/^[a-f0-9]{12}$/.test(expectedShort) && /^[a-f0-9]{12}$/.test(permittedFromShort),
    "exact 12-character payload IDs required");
  const manifestFile = path.join(cliRoot, "install.json");
  const lock = path.join(cliRoot, ".install.lock");
  const token = process.pid + ":" + Date.now() + ":deploy-restore";
  const handle = await fs.open(lock, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("managed installer is concurrently locked");
    throw error;
  });
  try {
    try { await handle.writeFile(token + "\n"); } finally { await handle.close(); }
    const manifest = await readManifest(manifestFile);
    const linkTarget = await fs.readlink(path.join(cliRoot, "current"));
    const selected = path.basename(linkTarget);
    const manifestShort = path.basename(manifest.payloadPath);
    ensure(path.resolve(cliRoot, linkTarget) === path.resolve(manifest.payloadPath) &&
      selected === manifestShort && selected === manifest.sha.slice(0, 12),
      "managed symlink and manifest disagree");
    await safePayload(cliRoot, manifest.payloadPath);
    if (selected === expectedShort) {
      console.log("deploy-restore: original managed payload already selected");
      return { restored: false, short: selected };
    }
    ensure(selected === permittedFromShort, "unrelated managed payload selected");
    const prior = manifest.previous[0];
    ensure(prior?.sha && sha40.test(prior.sha) && prior.sha.slice(0, 12) === expectedShort,
      "previous managed payload is not expected original");
    await safePayload(cliRoot, prior.payloadPath);
    const replaced = {
      source: manifest.source, version: manifest.version, channel: manifest.channel,
      payloadPath: manifest.payloadPath, repo: manifest.repo, ref: manifest.ref,
      sha: manifest.sha, installedAt: manifest.installedAt,
    };
    const next = { schemaVersion: manifest.schemaVersion, ...prior,
      previous: [replaced, ...manifest.previous.slice(1)].slice(0, 2) };
    const tempManifest = manifestFile + ".deploy-restore-" + process.pid + ".tmp";
    try {
      await fs.writeFile(tempManifest, JSON.stringify(next, null, 2) + "\n",
        { flag: "wx", mode: 0o600 });
      await flip(cliRoot, prior.payloadPath);
      try { await fs.rename(tempManifest, manifestFile); }
      catch (error) {
        await flip(cliRoot, manifest.payloadPath);
        throw error;
      }
    } finally { await tryUnlink(tempManifest); }
    const confirmed = await readManifest(manifestFile);
    const link = path.basename(await fs.readlink(path.join(cliRoot, "current")));
    ensure(link === expectedShort && confirmed.sha === prior.sha,
      "atomic restore failed postcondition");
    console.log("deploy-restore: restored " + expectedShort + " with no Paperclip restart");
    return { restored: true, short: expectedShort };
  } finally {
    const owner = await fs.readFile(lock, "utf8").catch(error =>
      error.code === "ENOENT" ? "" : Promise.reject(error));
    if (owner.trim() === token) await tryUnlink(lock);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [action, original, from] = process.argv.slice(2);
  if (action !== "restore") {
    console.error("deploy-restore: expected restore action");
    process.exitCode = 2;
  } else {
    restoreInstallOnly({
      cliRoot: "/Volumes/NVM/Paperclip/cli", expectedShort: original, permittedFromShort: from,
    }).catch(error => {
      console.error("deploy-restore: FAIL: " + (error instanceof Error ? error.message : "unknown"));
      process.exitCode = 1;
    });
  }
}
