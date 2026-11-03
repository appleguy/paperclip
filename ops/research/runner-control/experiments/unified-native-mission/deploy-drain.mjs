#!/usr/bin/env node
// Scoped companion to bin/pc-deploy. No new credentials, services, or inference.
// Only the existing instance-admin CLI credential may call Paperclip's audited task-drain API.
// OpenCode interrupts require a verified, run-specific L2 durable binding.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SCRATCH = "/Volumes/NVM/AI_Agent_Runtime/tmp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^ses_[a-zA-Z0-9_-]{6,100}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const ensure = (condition, why) => { if (!condition) throw new Error(why); };
const now = () => new Date().toISOString();

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function writePrivate(file, data) {
  ensure(path.resolve(file).startsWith(SCRATCH + "/"), "manifest must be under private runtime scratch");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
function safePath(file) {
  ensure(typeof file === "string" && path.resolve(file).startsWith(SCRATCH + "/"),
    "private manifest path required");
  return file;
}

export async function makeClient(options = {}) {
  const home = process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip");
  const ctx = await readJson(process.env.PAPERCLIP_CONTEXT || path.join(home, "context.json"));
  const profile = ctx.profiles?.[ctx.currentProfile];
  const base = profile?.apiBase;
  ensure(typeof base === "string" && /^https?:\/\//.test(base), "missing Paperclip CLI API base");
  const endpoint = new URL(base);
  ensure(["10.0.1.100", "Scotts-Mac-Pro.local", "127.0.0.1", "localhost"].includes(endpoint.hostname),
    "CLI API base is not the authorized Mac Pro instance");
  const store = await readJson(process.env.PAPERCLIP_AUTH_STORE || path.join(home, "auth.json"));
  const token = store.credentials?.[base.replace(/\/+$/, "")]?.token;
  ensure(typeof token === "string" && token.length > 12, "missing existing instance-admin CLI credential");
  const localUrl = options.baseUrl || "http://127.0.0.1:3100";
  ensure(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(localUrl), "Paperclip API must be loopback");
  return {
    companyId: profile?.companyId,
    api: (method, uri, body) => jsonRequest(localUrl, { authorization: "Bearer " + token }, method, uri, body),
  };
}

export async function jsonRequest(base, headers, method, uri, body, fetcher = fetch) {
  ensure(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(base), "provider/API request is not loopback");
  ensure(uri.startsWith("/") && !uri.startsWith("//"), "invalid request path");
  let response;
  try {
    response = await fetcher(base + uri, {
      method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("local " + method + " transport unavailable");
  }
  ensure(response.ok, "local " + method + " returned HTTP " + response.status);
  if (response.status === 204) return null;
  let data;
  try { data = await response.json(); }
  catch { throw new Error("local " + method + " returned non-JSON"); }
  return object(data) && Object.hasOwn(data, "data") ? data.data : data;
}

function uptimeSec(pid) {
  ensure(Number.isInteger(pid) && pid > 1, "missing server process identity");
  const etime = execFileSync("/bin/ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8", timeout: 3000 }).trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(etime);
  ensure(match, "could not verify current server uptime");
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 +
    Number(match[3]) * 60 + Number(match[4]);
}
const VERIFIED = SCRATCH + "/pc-deploy-verified.json";
async function liveServer(client) {
  const [health, state] = await Promise.all([
    client.api("GET", "/api/health"),
    client.api("GET", "/api/instance/task-drain?upgradeReadiness=1"),
  ]);
  ensure(health?.status === "ok" && Number.isInteger(state?.serverPid) && state.serverPid > 1,
    "Paperclip process is not healthy or has no verified identity");
  return { health, state };
}
async function currentPayload() {
  return path.basename(await fs.readlink("/Volumes/NVM/Paperclip/cli/current"));
}

/** A different controller may kickstart while we are waiting for the 30-minute
 * spacing gate. During that restart, HTTP can refuse connections or advertise
 * "starting". Retry transient startup for up to four minutes; never mistake
 * unknown identity for a healthy process or bypass the uptime pacing gate. */
export async function retryHealthyIdentity(probe, { timeoutMs = 240_000 } = {},
  controls = { now: Date.now, sleep }) {
  const end = controls.now() + timeoutMs;
  while (true) {
    try {
      return await probe();
    } catch (error) {
      if (!(error instanceof Error) ||
        !(/local GET transport unavailable|Paperclip process is not healthy or has no verified identity/.test(error.message))) {
        throw error;
      }
    }
    const remaining = end - controls.now();
    if (remaining <= 0) break;
    await controls.sleep(Math.min(3_000, remaining));
  }
  throw new Error("Paperclip preflight health/process identity unavailable after 240 seconds");
}

/** A kickstart can serve HTTP 200 with status=starting before identity and
 * readiness converge. Require a new PID, exact payload and two stable healthy
 * observations 8 seconds apart; retry transient transport/starting responses. */
export async function waitForRestartReady(probe, { previousPid, sha, timeoutMs = 240_000 },
  controls = { now: Date.now, sleep }) {
  ensure(Number.isInteger(previousPid) && previousPid > 1 && /^[0-9a-f]{40}$/.test(sha),
    "restart identity inputs are invalid");
  const end = controls.now() + timeoutMs;
  let stablePid = null;
  let stableSince = 0;
  while (true) {
    try {
      const { health, state, payload } = await probe();
      const healthy = health?.status === "ok" && Number.isInteger(state?.serverPid) &&
        state.serverPid > 1 && state.serverPid !== previousPid && state.draining === false &&
        payload === sha.slice(0, 12) && (typeof health.commit !== "string" || health.commit === sha);
      if (healthy) {
        if (stablePid === state.serverPid && controls.now() - stableSince >= 8_000) {
          return { health, state };
        }
        if (stablePid !== state.serverPid) { stablePid = state.serverPid; stableSince = controls.now(); }
      } else { stablePid = null; }
    } catch { stablePid = null; }
    const remaining = end - controls.now();
    if (remaining <= 0) break;
    await controls.sleep(Math.min(4_000, remaining));
  }
  throw new Error("Paperclip restart did not reach stable health and verified new process identity within 240 seconds");
}
async function isVerified(client, sha) {
  ensure(/^[0-9a-f]{40}$/.test(sha), "expected exact commit SHA");
  const { health, state } = await retryHealthyIdentity(() => liveServer(client));
  ensure(!state.draining, "another task drain is active");
  const receipt = await readJson(VERIFIED).catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
  return receipt?.schema === 1 && receipt.sha === sha && receipt.serverPid === state.serverPid &&
    (await currentPayload()) === sha.slice(0, 12) &&
    (typeof health.commit !== "string" || health.commit === sha);
}
async function status(client) {
  const value = await client.api("GET", "/api/instance/task-drain");
  ensure(object(value) && typeof value.draining === "boolean" &&
    Number.isInteger(value.activeRuns) && Number.isInteger(value.pendingWakes), "invalid drain response");
  return value;
}
async function held(client, manifest) {
  const s = await status(client);
  ensure(s.draining && s.startedAt === manifest.startedAt, "deploy admission fence was lost or replaced");
  return s;
}
async function listRunning(client) {
  const companies = await client.api("GET", "/api/companies");
  ensure(Array.isArray(companies) && companies.length > 0 && companies.length < 100,
    "cannot verify all companies");
  const runs = [];
  for (const company of companies) {
    ensure(UUID.test(company.id), "invalid company inventory");
    const rows = await client.api("GET", "/api/companies/" + company.id + "/live-runs?limit=1000");
    ensure(Array.isArray(rows) && rows.length < 1000, "live-run inventory truncated or invalid");
    for (const run of rows) if (run.status === "running") {
      ensure(UUID.test(run.id) && UUID.test(run.agentId) && (run.issueId == null || UUID.test(run.issueId)),
        "invalid run identity");
      runs.push(run);
    }
  }
  return runs;
}

export function verifyOwned(runs, agents, bindings, active) {
  const planned = [];
  const selected = new Set();
  // Owner policy 2026-11-02: deploys never wait. A run with no journaled
  // OpenCode session (Claude/Codex/agy, NAR, pre-journal) is not paused; the
  // restart loses its process and server recovery re-runs or rejoins it.
  for (const run of runs) {
    const agent = agents.get(run.agentId);
    ensure(agent, "running run agent unavailable");
    const match = agent.adapterType === "opencode_local" && agent.url
      ? bindings.filter(b => b.runId === run.id && b.agentId === run.agentId) : [];
    ensure(match.length <= 1, "conflicting durable OpenCode run/session bindings");
    if (match.length === 0) {
      planned.push({ runId: run.id, issueId: run.issueId ?? null, agentId: run.agentId, taskId: null,
        sessionId: null, url: null, active: false, state: "restart-lost" });
      continue;
    }
    const b = match[0];
    ensure(SESSION.test(b.sessionId) && UUID.test(b.taskId) && b.taskId === run.issueId,
      "journal task/session identity does not match the running issue");
    ensure(b.url === agent.url && b.cwd === agent.cwd, "journal server/workspace identity changed");
    ensure(!selected.has(b.url + "/" + b.sessionId), "two runs claim one session");
    selected.add(b.url + "/" + b.sessionId);
    planned.push({ runId: run.id, issueId: run.issueId, agentId: run.agentId,
      taskId: b.taskId, sessionId: b.sessionId, url: b.url, active: false, state: "planned" });
  }
  for (const [url, states] of active) {
    ensure(object(states), "unverifiable provider active sessions");
    for (const [sid, state] of Object.entries(states)) {
      if (state?.type === "idle") continue;
      ensure(SESSION.test(sid), "invalid active OpenCode session identity");
      // A Paperclip restart does not touch the OpenCode server: an unowned
      // session keeps running and never blocks a deploy.
      if (!selected.has(url + "/" + sid)) continue;
      const record = planned.find(p => p.url === url && p.sessionId === sid);
      record.active = true;
    }
  }
  return planned;
}

async function provider(config) {
  const url = config.url;
  ensure(typeof url === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(url),
    "OpenCode server is not loopback");
  ensure(typeof config.passwordFile === "string" && path.isAbsolute(config.passwordFile),
    "OpenCode credential path is invalid");
  const password = (await fs.readFile(config.passwordFile, "utf8")).trim();
  ensure(password && password.length <= 4096, "OpenCode credential unavailable");
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
  return {
    url,
    request: (method, uri, body) => jsonRequest(url, headers, method, "/api" + uri, body),
  };
}

/** Only busy/running, >=3-minute-stale, journal-free sessions with no
 * unpaired Paperclip run on that provider are eligible for orphan cleanup. */
export function selectStaleUnowned(active, details, runs, agents, bindings, journals, at = Date.now()) {
  const candidates = [];
  for (const [url, states] of active) {
    ensure(object(states), "unverifiable provider active sessions");
    const unpairedRun = runs.some(run => agents.get(run.agentId)?.url === url &&
      !bindings.some(b => b.agentId === run.agentId && b.runId === run.id));
    for (const [sessionId, status] of Object.entries(states)) {
      if (status?.type === "idle") continue;
      ensure(SESSION.test(sessionId), "invalid active OpenCode session identity");
      if (!["busy", "running"].includes(status?.type) || unpairedRun) continue;
      const owners = bindings.filter(b => b.url === url && b.sessionId === sessionId);
      // Zombie: every journal owner's run is terminal (e.g. cancelled by an
      // agent pause) yet the provider turn is still generating. Its owner is
      // gone, so it is interrupted at once, with no staleness wait.
      const zombie = owners.length > 0 && !owners.some(b => runs.some(run => run.id === b.runId));
      if (!zombie && (owners.length > 0 || journals.has(url + "/" + sessionId))) continue;
      const updated = details.get(url + "/" + sessionId)?.time?.updated;
      if (!Number.isSafeInteger(updated) || updated <= 0 || updated > at ||
        (!zombie && at - updated < 180_000)) continue;
      candidates.push({ url, sessionId, updatedAt: updated, state: "planned", ...(zombie ? { zombie: true } : {}) });
    }
  }
  ensure(candidates.length <= 100, "too many unowned sessions to verify safely");
  return candidates;
}

export async function interruptStaleUnowned(candidates, providers, persist = async () => {},
  revalidate = async () => {}) {
  for (const item of candidates) {
    const provider = providers.get(item.url);
    ensure(provider && typeof provider.request === "function", "missing exact orphan provider");
    await revalidate(item);
    await persist(item); // 0600 durable intent *before* the destructive POST
    const reply = await provider.request("POST", "/session/" + item.sessionId + "/interrupt", {});
    ensure(reply?.interrupted === true, "OpenCode did not acknowledge stale-session interrupt");
    item.state = "interrupt-acknowledged"; await persist(item);
    let idle = false;
    for (let n = 0; n < 8; n++) {
      const states = await provider.request("GET", "/session/active");
      idle = object(states) && (!Object.hasOwn(states, item.sessionId) ||
        states[item.sessionId]?.type === "idle");
      if (idle) break;
      await sleep(200 * (n + 1));
    }
    ensure(idle, "stale OpenCode session remained active after interrupt");
    item.state = "interrupted-and-idle"; await persist(item);
  }
}

async function snapshot(client, record = null) {
  const runs = await listRunning(client);
  const agents = new Map();
  const bindings = [];
  const journals = new Set();
  const journalDirs = new Set();
  const providers = new Map();
  async function scanJournal(cfgPath, url) {
    const dir = path.join(path.dirname(cfgPath), "paperclip-opencode-session-recovery");
    if (journalDirs.has(dir)) return;
    journalDirs.add(dir);
    const filenames = await fs.readdir(dir).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e));
    for (const filename of filenames) {
      if (!/^[a-zA-Z0-9_-]{1,130}\.json$/.test(filename)) continue;
      const row = await readJson(path.join(dir, filename));
      if (SESSION.test(row?.sessionId)) journals.add(url + "/" + row.sessionId);
      if (row?.version === 1 && UUID.test(row.agentId) && UUID.test(row.runId) &&
        UUID.test(row.taskId) && SESSION.test(row.sessionId)) bindings.push(row);
    }
  }
  for (const run of runs) {
    if (agents.has(run.agentId)) continue;
    const agent = await client.api("GET", "/api/agents/" + run.agentId);
    const cfgPath = agent?.adapterConfig?.sharedServerRecoveryConfigPath;
    if (agent?.adapterType !== "opencode_local" || typeof cfgPath !== "string" || !path.isAbsolute(cfgPath)) {
      // Owner policy 2026-11-02: deploys never wait; verifyOwned marks this run restart-lost.
      agents.set(run.agentId, { adapterType: agent?.adapterType ?? "unknown", url: null, cwd: null });
      continue;
    }
    const cfg = await readJson(cfgPath);
    const p = await provider(cfg);
    const cwd = agent.adapterConfig.cwd;
    ensure(typeof cwd === "string" && path.isAbsolute(cwd), "agent workspace identity unavailable");
    agents.set(run.agentId, { adapterType: agent.adapterType, url: p.url, cwd });
    if (providers.has(p.url)) {
      ensure(providers.get(p.url).credentialPath === cfg.passwordFile, "conflicting server credentials");
    } else {
      providers.set(p.url, { ...p, credentialPath: cfg.passwordFile });
    }
    await scanJournal(cfgPath, p.url);
  }
  // Provider servers remain relevant even when no live run maps to them:
  // an orphan known only to the server cannot be silently abandoned.
  const configs = [
    "/Volumes/NVM/Paperclip/backends/opencode-glm-medium/server/shared-glm-mac.json",
    "/Volumes/NVM/Paperclip/backends/opencode-glm-flash/server/shared-deepseek.json",
  ];
  for (const filename of configs) {
    const cfg = await readJson(filename).catch(e => e.code === "ENOENT" ? null : Promise.reject(e));
    if (!cfg) continue;
    if (providers.has(cfg.url)) {
      ensure(providers.get(cfg.url).credentialPath === cfg.passwordFile, "conflicting server credentials");
    } else {
      const p = await provider(cfg);
      providers.set(p.url, { ...p, credentialPath: cfg.passwordFile });
    }
    await scanJournal(filename, cfg.url);
  }
  const active = new Map();
  for (const [url, p] of providers) {
    try {
      active.set(url, await p.request("GET", "/session/active"));
    } catch (error) {
      // A non-running model server has no provider work to orphan. Do not
      // require it to be started merely so a different model can deploy.
      const owned = runs.some(run => agents.get(run.agentId)?.url === url);
      if (owned || !(error instanceof Error) || !error.message.includes("transport unavailable")) throw error;
      active.set(url, {});
    }
  }
  if (record) {
    const details = new Map();
    for (const [url, states] of active) {
      ensure(object(states), "unverifiable provider active sessions");
      for (const [sid, state] of Object.entries(states)) {
        const live = bindings.some(b => b.url === url && b.sessionId === sid &&
          runs.some(run => run.id === b.runId));
        const bound = bindings.some(b => b.url === url && b.sessionId === sid);
        if (!["busy", "running"].includes(state?.type) || live ||
          (!bound && journals.has(url + "/" + sid))) continue;
        ensure(SESSION.test(sid), "invalid OpenCode session identity");
        details.set(url + "/" + sid, await providers.get(url).request("GET", "/session/" + sid));
      }
    }
    const candidates = selectStaleUnowned(active, details, runs, agents, bindings, journals);
    if (candidates.length) {
      ensure(typeof record.manifestFile === "string", "stale-session recovery requires a durable manifest");
      record.orphans ??= [];
      const persist = async item => {
        if (!record.orphans.some(o => o.url === item.url && o.sessionId === item.sessionId)) {
          record.orphans.push(item);
        }
        await writePrivate(record.manifestFile, record);
      };
      const initialRunIds = runs.map(run => run.id).sort().join(",");
      await interruptStaleUnowned(candidates, providers, persist, async item => {
        const p = providers.get(item.url);
        // Recheck activity, age, current Paperclip runs and all journal files
        // just before each exact-session POST. New work or a new journal wins.
        const [states, detail, latestRuns] = await Promise.all([
          p.request("GET", "/session/active"),
          p.request("GET", "/session/" + item.sessionId),
          listRunning(client),
        ]);
        ensure(["busy", "running"].includes(states?.[item.sessionId]?.type) &&
          (item.zombie || (detail?.time?.updated === item.updatedAt && Date.now() - item.updatedAt >= 180_000)),
          "orphan activity changed during safety recheck");
        ensure(latestRuns.map(run => run.id).sort().join(",") === initialRunIds,
          "Paperclip run set changed during orphan safety recheck");
        for (const dir of journalDirs) {
          const files = await fs.readdir(dir).catch(e => e.code === "ENOENT" ? [] : Promise.reject(e));
          for (const filename of files) {
            if (!/^[a-zA-Z0-9_-]{1,130}\.json$/.test(filename)) continue;
            const row = await readJson(path.join(dir, filename));
            // A zombie keeps its terminal-run journal; only a live run's claim wins.
            ensure(row?.sessionId !== item.sessionId ||
              (item.zombie && !latestRuns.some(run => run.id === row?.runId)),
              "new journal ownership appeared for orphan session");
          }
        }
      });
      for (const url of new Set(candidates.map(item => item.url))) {
        active.set(url, await providers.get(url).request("GET", "/session/active"));
      }
      console.log("deploy-drain: interrupted " + candidates.length + " stale unowned OpenCode session(s)");
    }
  }
  return { planned: verifyOwned(runs, agents, bindings, active), providers };
}

export async function pauseOwned(planned, providers, persist = async () => {}) {
  // The owner map and durable manifest are verified before the first POST.
  for (const item of planned) {
    if (!item.active) { item.state = "idle"; continue; }
    const p = providers.get(item.url);
    ensure(p && typeof p.request === "function", "missing exact provider");
    const reply = await p.request("POST", "/session/" + item.sessionId + "/interrupt", {});
    ensure(reply?.interrupted === true, "OpenCode failed to acknowledge exact-session interrupt");
    item.state = "interrupt-acknowledged";
    await persist();
  }
  for (const item of planned.filter(r => r.active)) {
    const p = providers.get(item.url);
    let idle = false;
    for (let n = 0; n < 6; n++) {
      const states = await p.request("GET", "/session/active");
      idle = object(states) && (!Object.hasOwn(states, item.sessionId) ||
        states[item.sessionId]?.type === "idle");
      if (idle) break;
      await sleep(150 * (n + 1));
    }
    ensure(idle, "OpenCode did not reach paused/idle state");
    item.state = "paused";
    await persist();
  }
  return planned;
}

async function main() {
  const [action, filename, extra] = process.argv.slice(2);
  ensure(["verified", "check", "pace", "begin", "wait", "pause", "verify", "release", "finish"].includes(action),
    "unknown deploy-drain action");
  const client = await makeClient();
  if (action === "verified") {
    const verified = await isVerified(client, filename);
    console.log("deploy-drain: serving process " + (verified ? "verified" : "unverified"));
    if (!verified) process.exitCode = 10;
    return;
  }
  if (action === "check" || action === "pace") {
    const end = Date.now() + (action === "pace" ? 2_400_000 : 0);
    while (true) {
      // A concurrent kickstart may temporarily report status=starting or
      // refuse HTTP. Once it is healthy, restart uptime is measured again.
      const { state } = await retryHealthyIdentity(() => liveServer(client));
      ensure(!state.draining, "another task drain is active");
      const age = uptimeSec(state.serverPid);
      if (age >= 1800) {
        console.log("deploy-drain: preflight PASS (server uptime " + age + "s, no existing fence)");
        return;
      }
      if (Date.now() >= end) throw new Error("30-minute deploy pacing gate active (" + age + "s)");
      await sleep(Math.min(10_000, Math.max(100, end - Date.now())));
    }
  }
  const file = safePath(filename);
  if (action === "begin") {
    const before = await client.api("GET", "/api/instance/task-drain?upgradeReadiness=1");
    ensure(!before.draining && Number.isInteger(before.serverPid), "another task drain owns admission");
    const started = await client.api("POST", "/api/instance/task-drain", { ttlMs: 1_200_000 });
    ensure(typeof started?.startedAt === "string", "task drain did not acknowledge start");
    const record = { schema: 1, startedAt: started.startedAt, serverPid: before.serverPid,
      manifestFile: file, phase: "draining", runs: [], orphans: [], createdAt: now(), evidence: [] };
    try {
      await writePrivate(file, record);
      await held(client, record);
    } catch (error) {
      const current = await status(client).catch(() => null);
      if (current?.draining && current.startedAt === started.startedAt) {
        await client.api("DELETE", "/api/instance/task-drain").catch(() => {});
      }
      throw error;
    }
    console.log("deploy-drain: admission fenced; active runs may finish normally");
    return;
  }
  const record = await readJson(file);
  ensure(record.schema === 1 && typeof record.startedAt === "string", "invalid private drain manifest");
  if (action === "release") {
    const s = await status(client);
    if (s.draining && s.startedAt === record.startedAt) {
      await client.api("DELETE", "/api/instance/task-drain");
      console.log("deploy-drain: admission restored after aborted deploy");
    } else {
      console.log("deploy-drain: original admission fence is no longer owned; no mutation");
    }
    record.phase = "released"; await writePrivate(file, record);
    return;
  }
  if (action === "finish") {
    ensure(typeof extra === "string" && /^[0-9a-f]{40}$/.test(extra), "exact installed SHA required");
    const { state } = await waitForRestartReady(async () => {
      const [health, current, payload] = await Promise.all([
        client.api("GET", "/api/health"),
        client.api("GET", "/api/instance/task-drain?upgradeReadiness=1"),
        currentPayload(),
      ]);
      return { health, state: current, payload };
    }, { previousPid: record.serverPid, sha: extra });
    record.phase = "restarted-healthy"; record.finishedAt = now();
    record.evidence.push("new Paperclip PID, matching installed SHA, stable health; admission restored");
    await writePrivate(VERIFIED, { schema: 1, sha: extra, serverPid: state.serverPid,
      finishedAt: now(), manifest: file });
    await writePrivate(file, record);
    console.log("deploy-drain: restarted healthy; admission resumed; exact session journal retained (" +
      record.runs.length + " recorded run(s))");
    return;
  }
  await held(client, record);
  if (action === "verify") {
    ensure(["quiescent", "paused-for-restart"].includes(record.phase),
      "cannot restart before drain or pause completes");
    const s = await held(client, record);
    ensure(s.pendingWakes === 0, "new wakes are still in flight");
    const { planned } = await snapshot(client);
    ensure(planned.length <= record.runs.length, "new run appeared during fenced drain");
    for (const entry of planned) {
      const owned = record.runs.find(item => item.runId === entry.runId &&
        item.sessionId === entry.sessionId && item.url === entry.url);
      ensure(owned && !entry.active && ["paused", "idle"].includes(owned.state),
        "run/session has not reached a verified safe point");
    }
    console.log("deploy-drain: pre-kickstart safety barrier PASS (" + planned.length + " run(s))");
    return;
  }
  if (action === "wait") {
    const maxSec = extra === undefined ? 600 : Number(extra);
    ensure(Number.isInteger(maxSec) && maxSec >= 0 && maxSec <= 600, "drain wait bound invalid");
    const end = Date.now() + maxSec * 1000;
    do {
      const s = await held(client, record);
      const runs = await listRunning(client);
      if (s.activeRuns === 0 && s.pendingWakes === 0 && runs.length === 0) {
        // The database can be empty while an abandoned OpenCode server turn
        // is still generating. Never call this quiescent until every known
        // provider reports no unowned activity.
        try {
          const proof = await snapshot(client, record);
          ensure(proof.planned.length === 0, "running rows appeared during drain");
          record.phase = "quiescent"; await writePrivate(file, record);
          console.log("deploy-drain: quiescent (all recorded runs and provider sessions settled)");
          return;
        } catch (error) {
          // Fresh unowned sessions are not yet old enough to interrupt; keep
          // draining so they can become eligible without manual intervention.
          if (!(error instanceof Error) ||
            !error.message.includes("unowned or pre-journal OpenCode session")) throw error;
        }
      }
      if (Date.now() >= end) break;
      await sleep(Math.min(5_000, Math.max(0, end - Date.now())));
    } while (true);
    console.log("deploy-drain: bounded wait expired; requiring exact-session pause");
    process.exitCode = 10;
    return;
  }
  if (action === "pause") {
    const { planned, providers } = await snapshot(client, record);
    record.runs = planned;
    record.phase = "pausing";
    await writePrivate(file, record); // durable intent precedes any POST
    await pauseOwned(record.runs, providers, () => writePrivate(file, record));
    record.phase = "paused-for-restart";
    await writePrivate(file, record);
    console.log("deploy-drain: owned sessions paused and durably recorded (" + record.runs.length + ")");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    // Do not propagate provider errors, credentials, stack traces or response bodies.
    console.error("deploy-drain: FAIL: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  });
}
