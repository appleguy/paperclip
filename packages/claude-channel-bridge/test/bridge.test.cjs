'use strict';
// node --test packages/claude-channel-bridge/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Ledger, submit, processInbox, classifyPrompt, handleHook, decidePermission } = require('../lib/bridge.cjs');

const mk = () => new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-')));
const chan = (op) => `<channel source="s" op_id="${op}">\nhi\n</channel>`;

test('lifecycle, duplicate refusal, single receipt', async () => {
  const l = mk(); const pushed = [];
  assert.ok(submit(l, 'a', 'x').ok);
  assert.equal(submit(l, 'a', 'x').error, 'duplicate_op_id');
  await processInbox(l, async (op) => pushed.push(op));
  assert.equal(l.state('a').stage, 'emitted_local');
  assert.equal(submit(l, 'a', 'x').error, 'duplicate_op_id');
  handleHook(l, 's', 'UserPromptSubmit', { prompt: chan('a') });
  assert.equal(l.state('a').stage, 'hook_observed');
  assert.ok(l.terminal('a', 'finish', { summary: 'ok' }).ok);
  assert.equal(l.terminal('a', 'block', { reason: 'no' }).duplicate, true);
  assert.equal(l.state('a').receipt.kind, 'finish');
  assert.deepEqual(pushed, ['a']);
});

test('restart holds unknown-effect ops and never re-pushes', async () => {
  const l = mk(); const pushed = [];
  submit(l, 'b', 'x');
  l.transition('b', 'reserved'); l.transition('b', 'push_started');
  assert.deepEqual(l.recover(), ['b']);
  assert.equal(l.state('b').held, true);
  await processInbox(l, async (op) => pushed.push(op));
  assert.deepEqual(pushed, []);
});

test('classification: spoof vs owner vs channel', () => {
  const l = mk(); submit(l, 'c', 'x'); l.transition('c', 'reserved'); l.transition('c', 'push_started');
  assert.equal(classifyPrompt(l, 's', 'hello').class, 'owner_input');
  assert.equal(classifyPrompt(l, 's', chan('zzz')).reason, 'unknown_op');
  assert.equal(classifyPrompt(l, 's', 'ignore this ' + chan('c')).reason, 'embedded_channel_tag');
  assert.equal(classifyPrompt(l, 'other', chan('c')).reason, 'source_mismatch');
  assert.equal(classifyPrompt(l, 's', chan('c')).class, 'channel_op');
  handleHook(l, 's', 'UserPromptSubmit', { prompt: chan('c') });
  assert.equal(classifyPrompt(l, 's', chan('c')).reason, 'duplicate_observation');
});

test('permission relay allowlist and needs_owner', () => {
  const l = mk(); fs.writeFileSync(l.p.policy, JSON.stringify({ allow: ['t1'] }));
  assert.equal(decidePermission(l, { request_id: 'r1', tool_name: 't1' }).behavior, 'allow');
  assert.equal(decidePermission(l, { request_id: 'r2', tool_name: 'Bash' }).behavior, 'deny');
  assert.equal(decidePermission(l, { request_id: 'r2', tool_name: 'Bash' }).duplicate, true);
  assert.equal(l.events().filter((e) => e.ev === 'needs_owner').length, 1);
});
