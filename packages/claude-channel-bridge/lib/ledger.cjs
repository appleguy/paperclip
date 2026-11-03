'use strict';
// Durable append-only JSONL op ledger for the Claude channel bridge.
// State machine (spec native-agent-runtime.md section 2):
//   reserved -> push_started -> emitted_local -> hook_observed -> terminal
// "held_unknown_effect" is a flag, never inferred "lost"; it never triggers a re-push.
const fs = require('fs');
const path = require('path');

const STAGES = ['reserved', 'push_started', 'emitted_local', 'hook_observed', 'terminal'];
const RANK = Object.fromEntries(STAGES.map((s, i) => [s, i]));
const OP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function resolvePaths(dir) {
  return {
    dir,
    ledger: path.join(dir, 'ledger.jsonl'),
    inbox: path.join(dir, 'inbox'),
    processed: path.join(dir, 'processed'),
    refused: path.join(dir, 'refused'),
    policy: path.join(dir, 'policy.json'),
  };
}

function ensureDirs(p) {
  for (const d of [p.dir, p.inbox, p.processed, p.refused]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.ledger)) fs.closeSync(fs.openSync(p.ledger, 'a'));
}

// One write() of one line on an O_APPEND fd is atomic for these sizes; fsync before returning.
function append(file, obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + '\n';
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return JSON.parse(line);
}

function readEvents(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn tail line: ignore */ }
  }
  return out;
}

function fold(events) {
  const ops = {};
  for (const e of events) {
    if (!e.op_id) continue;
    if (!ops[e.op_id] && !(e.ev in RANK)) continue; // refusals/spoof notes never create an op
    const o = (ops[e.op_id] ||= { op_id: e.op_id, stage: null, held: false, receipt: null, history: [] });
    o.history.push(e.ev);
    if (e.ev in RANK) {
      if (o.stage === null || RANK[e.ev] > RANK[o.stage]) o.stage = e.ev;
      if (e.ev === 'hook_observed' || e.ev === 'terminal') o.held = false;
      if (e.ev === 'terminal' && !o.receipt) {
        o.receipt = { kind: e.kind, summary: e.summary, reason: e.reason, t: e.t };
      }
    } else if (e.ev === 'held_unknown_effect') {
      if (o.stage !== 'hook_observed' && o.stage !== 'terminal') o.held = true;
    }
  }
  return ops;
}

class Ledger {
  constructor(dir) {
    this.p = resolvePaths(dir);
    ensureDirs(this.p);
  }
  events() { return readEvents(this.p.ledger); }
  ops() { return fold(this.events()); }
  state(opId) { return this.ops()[opId] || null; }
  record(obj) { return append(this.p.ledger, obj); }

  // Idempotent forward transition. Returns {applied, state}.
  transition(opId, ev, extra = {}) {
    const st = this.state(opId);
    if (st && st.stage !== null && RANK[st.stage] >= RANK[ev]) return { applied: false, state: st };
    if (!st && ev !== 'reserved') return { applied: false, state: null, error: 'unknown_op' };
    this.record({ ev, op_id: opId, ...extra });
    return { applied: true, state: this.state(opId) };
  }

  // Exactly one terminal receipt per op; later calls return the existing receipt.
  terminal(opId, kind, payload) {
    const st = this.state(opId);
    if (!st) { this.record({ ev: 'terminal_refused', claimed_op_id: opId, kind, reason: 'unknown_op' }); return { ok: false, error: 'unknown_op' }; }
    if (st.receipt) {
      this.record({ ev: 'terminal_duplicate', op_id: opId, kind, existing_kind: st.receipt.kind });
      return { ok: true, duplicate: true, receipt: st.receipt };
    }
    const extra = { kind, hook_unobserved: RANK[st.stage] < RANK.hook_observed, ...payload };
    this.record({ ev: 'terminal', op_id: opId, ...extra });
    return { ok: true, duplicate: false, receipt: this.state(opId).receipt };
  }

  // On (re)start: unknown-effect ops are HELD, never re-pushed.
  recover() {
    const held = [];
    for (const o of Object.values(this.ops())) {
      if ((o.stage === 'push_started' || o.stage === 'emitted_local') && !o.held) {
        this.record({ ev: 'held_unknown_effect', op_id: o.op_id, from_stage: o.stage, reason: 'bridge_restart_without_hook_observed' });
        held.push(o.op_id);
      }
    }
    return held;
  }

  // The most recent op that is observed but has no receipt (best-effort correlation).
  activeOp() {
    const ops = Object.values(this.ops()).filter((o) => o.stage === 'hook_observed');
    return ops.length ? ops[ops.length - 1].op_id : null;
  }
}

module.exports = { Ledger, STAGES, RANK, OP_ID_RE, resolvePaths, append, readEvents, fold };
