#!/usr/bin/env node
// Which live Paperclip run (if any) owns each OpenCode session id.
//   pcview live --limit 30 | opencode-session-runs.mjs <ses_id>...   ->  one "<ses_id>\t<running|queued>" per owned id
// A session an OpenCode server reports active but no live run owns is an orphan: herdr-opencode-panes.sh labels its tab.
// sessionIdFor mirrors packages/adapters/opencode-local/src/server/nar/opencode-http-driver.ts (pinned by
// src/server/nar/session-id-mirror.test.ts); a session id is a hash, so every generation up to the cap is enumerated.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_SESSION_GENERATION = 500;
// Runners that create their own random-id session (backends/opencode-qwen-*/bin/opencode) write the owning run id here.
export const SESSION_RUNS_DIR = "/Volumes/NVM/Paperclip/backends/session-runs";

const recordedRunId = (id, dir) => {
  try { return readFileSync(`${dir}/${id}`, "utf8").trim(); } catch { return ""; }
};

export const sessionIdFor = (agentId, issueId, generation = 0) =>
  `ses_${createHash("sha256").update(`nar|${agentId}|${issueId}${generation > 0 ? `|g${generation}` : ""}`).digest("hex").slice(0, 26)}`;

/** @param {Array<{status?: string, agentId?: string, issueId?: string}>} runs @param {Iterable<string>} wanted */
export function ownedSessions(runs, wanted, recordDir = SESSION_RUNS_DIR) {
  const ids = new Set(wanted);
  const owned = new Map();
  const byRunId = new Map(runs.filter((r) => r?.id).map((r) => [r.id, r]));
  for (const id of ids) {
    const run = byRunId.get(recordedRunId(id, recordDir));
    if (run) owned.set(id, run.status === "running" ? "running" : "queued");
  }
  for (const run of runs) {
    if (!run?.agentId || !run?.issueId) continue;
    const state = run.status === "running" ? "running" : "queued";
    for (let g = 0; g <= MAX_SESSION_GENERATION; g++) {
      const id = sessionIdFor(run.agentId, run.issueId, g);
      if (!ids.has(id)) continue;
      // A running run outranks a queued retry of the same session.
      if (owned.get(id) !== "running") owned.set(id, state);
    }
  }
  return owned;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const live = JSON.parse(raw);
  if (!Array.isArray(live?.runs)) throw new Error("expected pcview live JSON with a runs array");
  for (const [id, state] of ownedSessions(live.runs, process.argv.slice(2))) process.stdout.write(`${id}\t${state}\n`);
}
