#!/usr/bin/env node
// SCO-818: hot-vs-full deploy planner and hot activation for bin/pc-deploy.
//   hot-deploy.mjs plan <sha>      exit 0 hot (restart-free), 10 full restart, 11 already live, 12 no payload change
//   hot-deploy.mjs activate <sha>  write the hot marker for the installed payload and wait for the server's ack
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient } from "./deploy-drain.mjs";

const repo = "/Volumes/NVM/Paperclip";
const master = repo + "/master";
const hotDir = (process.env.PAPERCLIP_HOME || repo) + "/hot";
const rules = path.resolve(master, "server/src/hot/hot-paths.txt");

export function parseRules(text) {
  const r = { hot: new Set(), hotGlob: [], nonePrefix: [], noneSuffix: [] };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [kind, value] = line.split(/\s+/);
    if (kind === "hot") r.hot.add(value);
    else if (kind === "hot-glob") r.hotGlob.push(new RegExp("^" + value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$"));
    else if (kind === "none-prefix") r.nonePrefix.push(value);
    else if (kind === "none-suffix") r.noneSuffix.push(value);
  }
  return r;
}
/** hot | none | full for one changed path. */
export function classify(file, r) {
  if (r.hot.has(file) || r.hotGlob.some(g => g.test(file))) return "hot";
  if (r.nonePrefix.some(p => file.startsWith(p)) || r.noneSuffix.some(s => file.endsWith(s))) return "none";
  return "full";
}
export function plan(files, r) {
  const kinds = files.map(f => classify(f, r));
  if (kinds.includes("full")) return "full";
  return kinds.includes("hot") ? "hot" : "none";
}
const readJson = f => fs.readFile(f, "utf8").then(JSON.parse);

async function main() {
  const [action, sha] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(sha || "")) { console.error("expected exact commit SHA"); process.exit(2); }
  const client = await makeClient();
  const [health, state] = await Promise.all([client.api("GET", "/api/health"), client.api("GET", "/api/instance/task-drain?upgradeReadiness=1")]);
  // Served build: health.commit, else the full-deploy receipt for this exact server pid.
  const receipt = await readJson("/Volumes/NVM/AI_Agent_Runtime/tmp/pc-deploy-verified.json").catch(() => null);
  const base = health?.commit || (receipt?.serverPid === state?.serverPid ? receipt.sha : null);
  if (action === "plan") {
    if (health?.status !== "ok" || !/^[0-9a-f]{40}$/.test(base || "")) { console.log("hot-deploy: server build identity unknown; full restart"); process.exit(10); }
    const marker = await readJson(hotDir + "/active.json").catch(() => null);
    const ack = await readJson(hotDir + "/loaded.json").catch(() => null);
    if (marker?.baseSha === base && marker.hotSha === sha && ack?.hotSha === sha && ack.pid === state?.serverPid) {
      console.log(`hot-deploy: ${sha.slice(0, 12)} already live (hot)`); process.exit(11);
    }
    let files;
    try {
      files = execFileSync("git", ["-C", master, "diff", "--name-only", base, sha], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch { console.log("hot-deploy: cannot diff served build; full restart"); process.exit(10); }
    const kind = plan(files, parseRules(await fs.readFile(rules, "utf8")));
    console.log(`hot-deploy: ${files.length} changed file(s) since served ${base.slice(0, 12)} -> ${kind}`);
    process.exit(kind === "hot" ? 0 : kind === "none" ? 12 : 10);
  }
  if (action === "activate") {
    const distRoot = path.join(await fs.realpath(repo + "/cli/current"), "node_modules/@paperclipai/server/dist");
    await fs.access(path.join(distRoot, "adapters/claude-rc/execute.js"));
    await fs.mkdir(hotDir, { recursive: true });
    const tmp = hotDir + "/active.json." + process.pid;
    await fs.writeFile(tmp, JSON.stringify({ schema: 1, baseSha: base, hotSha: sha, distRoot }));
    await fs.rm(hotDir + "/loaded.json", { force: true });
    await fs.rename(tmp, hotDir + "/active.json");
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const ack = await readJson(hotDir + "/loaded.json").catch(() => null);
      if (ack?.hotSha === sha && ack.pid === state.serverPid) { console.log(`hot-deploy: ${sha.slice(0, 12)} live in running server pid ${ack.pid}; 0 runs interrupted`); return; }
    }
    await fs.rm(hotDir + "/active.json", { force: true });
    console.error("hot-deploy: server did not acknowledge hot payload; marker removed"); process.exit(1);
  }
  console.error("unknown action"); process.exit(2);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error("hot-deploy: " + e.message); process.exit(1); });
