#!/usr/bin/env node
'use strict';
// bridge-ctl submit <op_id> --stdin | status [op_id] | ledger (env PC_BRIDGE_DIR)
// Never put a Paperclip prompt in argv. The legacy text-argv form remains for probes.
const fs = require('fs');
const path = require('path');
const { Ledger, submit } = require('../lib/bridge.cjs');
const { OP_ID_RE } = require('../lib/ledger.cjs');
const dir = process.env.PC_BRIDGE_DIR;
if (!dir) { console.error('PC_BRIDGE_DIR required'); process.exit(2); }
const ledger = new Ledger(dir);
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'submit') {
  let content;
  if (args[1] === '--stdin' && args.length === 2) {
    content = fs.readFileSync(0, 'utf8');
  } else if (args.length >= 2 && args[1] !== '--stdin') {
    content = args.slice(1).join(' '); // backwards-compatible diagnostic use only
  } else {
    console.error('usage: bridge-ctl submit <op_id> --stdin');
    process.exit(2);
  }
  if (!content || content.length > 100_000) {
    console.error('bridge submit requires a nonempty prompt <=100000 chars');
    process.exit(2);
  }
  const r = submit(ledger, args[0], content);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'status') {
  const ops = ledger.ops();
  const view = (o) => ({ op_id: o.op_id, stage: o.stage, hook_observed: o.observed, held_unknown_effect: o.held, receipt: o.receipt });
  // A submitted inbox item exists before the consumer reserves it. Treat it
  // as an already-admitted UNKNOWN effect so an adapter cannot paste a duplicate.
  const id = args[0];
  const queued = id && OP_ID_RE.test(id) && fs.existsSync(path.join(ledger.p.inbox, id + '.json'));
  const one = id ? (ops[id] ? view(ops[id]) : queued
    ? { op_id: id, stage: 'inbox_pending', hook_observed: false, held_unknown_effect: true, receipt: null }
    : null) : null;
  console.log(JSON.stringify(id ? one : Object.values(ops).map(view), null, 2));
} else if (cmd === 'ledger') {
  for (const e of ledger.events()) console.log(JSON.stringify(e));
} else {
  console.error('usage: bridge-ctl submit <op_id> --stdin | status [op_id] | ledger');
  process.exit(2);
}
