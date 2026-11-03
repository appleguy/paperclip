#!/usr/bin/env node
'use strict';
// Claude Code hook entry (UserPromptSubmit | PostToolUse | Stop). Observation only: never blocks,
// never completes a run. Env: PC_BRIDGE_DIR (state dir), PC_BRIDGE_SERVER (channel server name).
const { Ledger, handleHook } = require('./lib/bridge.cjs');
const event = process.argv[2] || 'unknown';
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const ledger = new Ledger(process.env.PC_BRIDGE_DIR);
    handleHook(ledger, process.env.PC_BRIDGE_SERVER || 'pcbridge', event, input);
  } catch (e) {
    try { require('fs').appendFileSync((process.env.PC_BRIDGE_DIR || '.') + '/hook-errors.log', `${new Date().toISOString()} ${e.stack}\n`); } catch {}
  }
  process.exit(0);
});
