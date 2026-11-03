#!/usr/bin/env node
"use strict";

// agy statusLine.command child: receives its public session snapshot on stdin.
// Only the fields needed for input arbitration are retained, never the raw JSON.
const fs = require("node:fs");
const path = require("node:path");

// One or more ABSOLUTE_STATE_FILE ABSOLUTE_AGY_CWD pairs: statusLine is a global agy setting,
// so every agy_local agent's pair is listed and the snapshot goes to the pair matching the TUI's cwd.
const args = process.argv.slice(2);
const pairs = [];
for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
if (!pairs.length || args.length % 2 !== 0 || pairs.some(([f, c]) => !path.isAbsolute(f) || !path.isAbsolute(c))) {
  process.stderr.write("usage: node statusline.cjs (ABSOLUTE_STATE_FILE ABSOLUTE_AGY_CWD)...\n");
  process.exit(2);
}

const states = new Set(["idle", "working", "tool_use", "reviewing", "authenticating", "initializing", "error"]);
let input = "";
let finished = false;
const finish = (raw) => {
  if (finished) return;
  finished = true;
  writeSnapshot(raw);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part) => {
  input += part;
  if (input.length > 64 * 1024) {
    // A malformed/oversized update must never leave a trusted old idle signal.
    process.stdin.destroy();
    finish(null);
  }
});
process.stdin.on("end", () => finish(input));
process.stdin.on("error", () => finish(null));

function writeSnapshot(raw) {
  let payload = null;
  try {
    if (raw) payload = JSON.parse(raw);
  } catch { /* Treat malformed updates as unknown, never idle. */ }
  const sourceCwd = typeof payload?.cwd === "string" ? path.resolve(payload.cwd) : null;
  const pair = (sourceCwd && pairs.find(([, c]) => path.resolve(c) === sourceCwd)) || pairs[0];
  const [stateFile, expectedCwd] = pair;
  if (sourceCwd && sourceCwd !== path.resolve(expectedCwd)) {
    // statusLine is a global agy setting. Never let another TUI overwrite
    // this agent's snapshot when its working directory is different.
    process.stdout.write("agy (other workspace)\n");
    return;
  }

  const agentState = sourceCwd === path.resolve(expectedCwd) && states.has(payload?.agent_state)
    ? payload.agent_state : "unknown";
  const conversationId = typeof payload?.conversation_id === "string"
    ? payload.conversation_id : null;
  const now = new Date().toISOString();
  let idleSince = agentState === "idle" ? now : null;
  if (idleSince) {
    try {
      const prior = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const priorMs = Date.parse(prior.idleSince);
      if (prior.schemaVersion === 1 && prior.agentState === "idle"
          && prior.cwd === path.resolve(expectedCwd)
          && prior.conversationId === conversationId
          && Number.isFinite(priorMs) && priorMs <= Date.now()) {
        idleSince = prior.idleSince;
      }
    } catch { /* First observation, or previously invalid state. */ }
  }
  const snapshot = {
    schemaVersion: 1,
    agentState,
    observedAt: now,
    idleSince,
    cwd: path.resolve(expectedCwd),
    conversationId,
    pendingInputCount: Number.isSafeInteger(payload?.pending_input_count)
      && payload.pending_input_count >= 0 ? payload.pending_input_count : 0,
    toolConfirmationPending: payload?.tool_confirmation_pending === true,
  };
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(snapshot) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, stateFile);
    process.stdout.write(`agy ${agentState}\n`);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    process.stderr.write(`agy status snapshot failed: ${err instanceof Error ? err.code || err.name : "error"}\n`);
    process.exitCode = 1;
  }
}
