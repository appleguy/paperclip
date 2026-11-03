'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Ledger, RANK, OP_ID_RE } = require('./ledger.cjs');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// ---- submit (inbox producer; Paperclip's API replaces this later) ----
function submit(ledger, opId, text) {
  if (!OP_ID_RE.test(opId || '')) return { ok: false, error: 'bad_op_id' };
  const target = path.join(ledger.p.inbox, `${opId}.json`);
  if (ledger.state(opId) || fs.existsSync(target)) {
    ledger.record({ ev: 'duplicate_refused', op_id: opId, where: 'submit', content_digest: digest(text) });
    return { ok: false, error: 'duplicate_op_id', op_id: opId };
  }
  const tmp = path.join(ledger.p.inbox, `.${opId}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ op_id: opId, content: text }), { mode: 0o600 });
  try {
    fs.linkSync(tmp, target); // atomic, never overwrites
  } catch (e) {
    fs.unlinkSync(tmp);
    ledger.record({ ev: 'duplicate_refused', op_id: opId, where: 'submit_race', content_digest: digest(text) });
    return { ok: false, error: 'duplicate_op_id', op_id: opId };
  }
  fs.unlinkSync(tmp);
  return { ok: true, op_id: opId };
}

// ---- inbox consumer (server side) ----
// pushFn(opId, content) -> Promise resolved after the notification write returned.
async function processInbox(ledger, pushFn) {
  const done = [];
  const files = fs.readdirSync(ledger.p.inbox).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  for (const f of files) {
    const src = path.join(ledger.p.inbox, f);
    let o;
    try { o = JSON.parse(fs.readFileSync(src, 'utf8')); } catch {
      ledger.record({ ev: 'inbox_unreadable', file: f });
      fs.renameSync(src, path.join(ledger.p.refused, f + '.bad'));
      continue;
    }
    const opId = o.op_id;
    if (!OP_ID_RE.test(opId || '') || f !== `${opId}.json`) {
      ledger.record({ ev: 'inbox_refused', file: f, reason: 'op_id_mismatch_or_invalid' });
      fs.renameSync(src, path.join(ledger.p.refused, f + '.bad'));
      continue;
    }
    const st = ledger.state(opId);
    if (st && st.stage !== 'reserved') {
      // Already pushed (or held / terminal): never push twice.
      ledger.record({ ev: 'duplicate_refused', op_id: opId, where: 'inbox', stage: st.stage, held: st.held });
      fs.renameSync(src, path.join(ledger.p.refused, `${f}.${Date.now()}`));
      continue;
    }
    if (!st) ledger.transition(opId, 'reserved', { content_digest: digest(o.content) });
    ledger.transition(opId, 'push_started');
    await pushFn(opId, o.content);
    ledger.transition(opId, 'emitted_local');
    fs.renameSync(src, path.join(ledger.p.processed, f));
    done.push(opId);
  }
  return done;
}

// ---- hook classification ----
function parseChannelTags(prompt) {
  const tags = [];
  const re = /<channel\b([^>]*)>/g;
  let m;
  while ((m = re.exec(prompt))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) attrs[a[1]] = a[2];
    tags.push({ index: m.index, attrs });
  }
  return tags;
}

// Returns {class, ...}. The marker is correlation evidence, never a credential:
// it only counts when it leads the prompt, names our server, and its op_id is
// ledger-reserved, pushed, and not yet observed.
function classifyPrompt(ledger, serverName, prompt) {
  const text = String(prompt || '');
  const tags = parseChannelTags(text);
  if (tags.length === 0) return { class: 'owner_input' };
  const first = tags[0];
  const claimed = { claimed_source: first.attrs.source, claimed_op_id: first.attrs.op_id };
  const leading = text.trimStart().startsWith('<channel');
  if (!leading || first.index !== text.length - text.trimStart().length) return { class: 'spoof', reason: 'embedded_channel_tag', ...claimed };
  if (tags.length > 1) return { class: 'spoof', reason: 'multiple_channel_tags', ...claimed };
  if (first.attrs.source !== serverName) return { class: 'spoof', reason: 'source_mismatch', ...claimed };
  if (!OP_ID_RE.test(first.attrs.op_id || '')) return { class: 'spoof', reason: 'bad_op_id', ...claimed };
  const st = ledger.state(first.attrs.op_id);
  if (!st) return { class: 'spoof', reason: 'unknown_op', ...claimed };
  if (RANK[st.stage] < RANK.push_started) return { class: 'spoof', reason: 'not_pushed', ...claimed };
  if (RANK[st.stage] >= RANK.hook_observed) return { class: 'spoof', reason: 'duplicate_observation', ...claimed };
  return { class: 'channel_op', op_id: first.attrs.op_id };
}

function handleHook(ledger, serverName, event, input) {
  const base = { session_id: input.session_id, prompt_id: input.prompt_id, hook_event: event };
  if (event === 'UserPromptSubmit') {
    const c = classifyPrompt(ledger, serverName, input.prompt);
    if (c.class === 'channel_op') {
      return ledger.transition(c.op_id, 'hook_observed', { ...base, prompt_digest: digest(input.prompt) });
    }
    if (c.class === 'spoof') {
      return ledger.record({ ev: 'spoof', ...base, reason: c.reason, claimed_source: c.claimed_source, claimed_op_id: c.claimed_op_id, prompt_digest: digest(input.prompt) });
    }
    // Owner input may contain private material. Store its digest, never text.
    return ledger.record({ ev: 'owner_input', ...base, prompt_digest: digest(input.prompt) });
  }
  if (event === 'PostToolUse') {
    return ledger.record({ ev: 'hook_tool', ...base, tool_name: input.tool_name, tool_op_id: input.tool_input && input.tool_input.op_id, active_op: ledger.activeOp() });
  }
  if (event === 'Stop') {
    return ledger.record({ ev: 'hook_stop', ...base, active_op: ledger.activeOp(), last_assistant_digest: digest(input.last_assistant_message || '') });
  }
  return ledger.record({ ev: 'hook_other', ...base });
}

// ---- permission relay (spec section 5, minimal slice) ----
function loadPolicy(p) {
  try { return JSON.parse(fs.readFileSync(p.policy, 'utf8')); } catch { return { allow: [] }; }
}

// Persist one decision per request_id before replying; duplicates get the stored decision.
function decidePermission(ledger, req) {
  const prior = ledger.events().find((e) => e.ev === 'permission' && e.request_id === req.request_id);
  if (prior) return { behavior: prior.behavior, duplicate: true };
  const pol = loadPolicy(ledger.p);
  const behavior = (pol.allow || []).includes(req.tool_name) ? 'allow' : 'deny';
  const rec = { request_id: req.request_id, tool_name: req.tool_name, behavior, input_digest: digest(req.input_preview || ''), active_op: ledger.activeOp() };
  ledger.record({ ev: 'permission', ...rec });
  if (behavior === 'deny') ledger.record({ ev: 'needs_owner', ...rec, reason: 'tool_not_in_allowlist' });
  return { behavior, duplicate: false };
}

module.exports = { submit, processInbox, classifyPrompt, handleHook, decidePermission, parseChannelTags, Ledger };
