#!/usr/bin/env node
'use strict';
// bridge-ctl submit <op_id> <text> | status [op_id] | ledger     (env PC_BRIDGE_DIR)
const { Ledger, submit } = require('../lib/bridge.cjs');
const dir = process.env.PC_BRIDGE_DIR;
if (!dir) { console.error('PC_BRIDGE_DIR required'); process.exit(2); }
const ledger = new Ledger(dir);
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'submit') {
  const r = submit(ledger, args[0], args.slice(1).join(' '));
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'status') {
  const ops = ledger.ops();
  const view = (o) => ({ op_id: o.op_id, stage: o.stage, held_unknown_effect: o.held, receipt: o.receipt });
  console.log(JSON.stringify(args[0] ? (ops[args[0]] ? view(ops[args[0]]) : null) : Object.values(ops).map(view), null, 2));
} else if (cmd === 'ledger') {
  for (const e of ledger.events()) console.log(JSON.stringify(e));
} else {
  console.error('usage: bridge-ctl submit <op_id> <text> | status [op_id] | ledger');
  process.exit(2);
}
