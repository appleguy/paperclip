#!/usr/bin/env node
/**
 * SCO-337 read-only external OpenCode activity projection.
 * No Paperclip writes, inference, provider password, native prompt or TUI control.
 * Never maps an external session onto a Paperclip heartbeat run.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_ROOT = "/Volumes/NVM/Research/project-maya-metal/opencode-ztop-medium";
const DEFAULT_WORKSPACE = "/Volumes/NVM/AI_Coding_Projects/zsys";
const ID = /^ses_[A-Za-z0-9_]{10,100}$/;
const FRESHNESS_MS = 120_000;
const HANDOFF_LIMIT = 3;

function safeId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("invalid native session id");
  return value;
}

export function buildProjection({state, original, events, sessions, serverVerified, now = Date.now()}) {
  if (state.original !== original || !state.active) throw new Error("guard anchor mismatch");
  const active = safeId(state.active);
  const root = safeId(original);
  const index = new Map(sessions.map(s => [safeId(s.id), s]));
  const chain = [root];
  if (!index.has(root)) throw new Error("root session not in bound store");
  let current = root;
  const visited = new Set(chain);
  // Only guard-committed successor receipts authorize transitions.
  const steps = events.filter(e => e.event === "successor_dispatched");
  for (const evt of steps) {
    if (evt.old !== current) continue;
    const successor = safeId(evt.new);
    if (visited.has(successor)) throw new Error("cycle in successor receipts");
    const s = index.get(successor);
    if (!s || s.metadata?.source !== "ztop-local-guard" ||
        s.metadata?.guardParent !== current) {
      throw new Error("missing native successor provenance");
    }
    chain.push(successor);
    visited.add(successor);
    current = successor;
    if (chain.length > 20) throw new Error("unbounded handoff lineage");
  }
  if (current !== active) throw new Error("active session lacks committed lineage");
  if (state.rotation_count !== chain.length - 1) throw new Error("handoff count mismatch");
  if (steps.length !== chain.length - 1) throw new Error("duplicate/foreign handoff events");
  const currentSession = index.get(active);
  if (!currentSession) throw new Error("active session disappeared");
  const lastUpdated = Number(currentSession.time_updated);
  if (!Number.isFinite(lastUpdated) || lastUpdated <= 0 || lastUpdated > now + 60_000)
    throw new Error("invalid native update time");
  const lastIdle = currentSession.time_idle == null ? null : Number(currentSession.time_idle);
  const fresh = now - lastUpdated <= FRESHNESS_MS;
  const handoff = state.phase === "rotating" || state.phase === "await_idle";
  const status = !serverVerified ? "unverified" :
    handoff ? "handoff" :
    (lastIdle != null && lastIdle >= lastUpdated) ? "idle" :
    fresh ? "observed_active" : "stale";
  return {
    stableExternalId: "external/mac-pro/ztop/maya-l-medium",
    kind: "external_opencode_activity",
    authority: "observer_only",
    paperclipRunId: null,
    paperclipAgentId: null,
    paperclipTaskCheckout: false,
    modelLabel: "GLM-5.3 Flash · Maya-L Medium",
    backend: "OpenCode v2.2.2",
    status,
    backendVerified: Boolean(serverVerified),
    currentSessionId: active,
    sessionLineage: chain,
    committedHandoffCount: chain.length - 1,
    handoffLimitReached: Number(state.rotation_count) >= HANDOFF_LIMIT,
    guardPhase: state.phase,
    lastNativeEventAt: new Date(lastUpdated).toISOString(),
    observedAt: new Date(now).toISOString(),
    claim: "advisory_presence_not_managed_execution",
  };
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function verifyOpenCodeServer(port, dbPath) {
  try {
    const pids = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      timeout: 2_000, encoding: "utf8", maxBuffer: 4096,
    }).trim().split(/\s+/).filter(Boolean);
    if (pids.length !== 1 || !/^\d+$/.test(pids[0])) return false;
    const fd = execFileSync("lsof", ["-nP", "-p", pids[0]], {
      timeout: 2_000, encoding: "utf8", maxBuffer: 131072,
    });
    return fd.split("\n").some(line => line.includes(dbPath) && line.includes("opencode.db"));
  } catch {
    return false;
  }
}

export function readLive(root = DEFAULT_ROOT, now = Date.now()) {
  const dbPath = path.join(root, "data/opencode/opencode.db");
  const state = readJson(path.join(root, "evidence/context-guard-state.json"));
  const original = fs.readFileSync(path.join(root, ".successor-session-id"), "utf8").trim();
  const activePointer = fs.readFileSync(path.join(root, ".guard-active-session-id"), "utf8").trim();
  if (activePointer !== state.active) throw new Error("active guard pointer does not match durable guard state");
  const events = fs.readFileSync(path.join(root, "evidence/context-guard-events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare("SELECT id, directory, parent_id, fork_session_id, metadata, time_updated, time_idle FROM session_v2").all();
  } finally {
    db.close();
  }
  // The workspace is pinned, not supplied by a browser or a provider event.
  const sessions = rows.filter(r => r.directory === DEFAULT_WORKSPACE)
    .map(r => ({...r, metadata: JSON.parse(r.metadata || "{}")}));
  // Other workspaces on a shared server are never promoted into this workflow.

  const projection = buildProjection({
    state, original, events, sessions,
    serverVerified: verifyOpenCodeServer(61866, dbPath), now,
  });
  return projection;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    console.log(JSON.stringify(readLive(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: "unverified", reason: String(error.message).slice(0, 150) }));
    process.exitCode = 2;
  }
}
