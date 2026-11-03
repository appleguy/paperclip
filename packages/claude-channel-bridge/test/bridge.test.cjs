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

test('bridge-ctl accepts private multiline prompt via stdin, not argv; duplicates refused', () => {
  const { spawnSync } = require('node:child_process');
  const ledger = mk();
  const ctl = path.resolve(__dirname, '../bin/bridge-ctl.cjs');
  const opId = 'stdin-test';
  const message = 'line one\nline two private-value-not-an-argv';
  const call = () => spawnSync(process.execPath, [ctl, 'submit', opId, '--stdin'], {
    env: { PC_BRIDGE_DIR: ledger.p.dir, PATH: process.env.PATH || '/usr/bin:/bin' },
    input: message, encoding: 'utf8',
  });
  const first = call();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ledger.p.inbox, opId + '.json'))),
    { op_id: opId, content: message });
  const second = call();
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stdout).error, 'duplicate_op_id');
});

test('emitted_local across a bridge restart is held, never pushed again', async () => {
  const ledger = mk();
  assert.equal(submit(ledger, 'emitted', 'private').ok, true);
  const pushed = [];
  await processInbox(ledger, async op => pushed.push(op));
  assert.deepEqual(pushed, ['emitted']);
  assert.deepEqual(ledger.recover(), ['emitted']);
  await processInbox(ledger, async op => pushed.push(op));
  assert.deepEqual(pushed, ['emitted']);
  assert.equal(ledger.state('emitted').held, true);
});

test('no terminal receipt without correlated hook; hook logs redact private text', () => {
  const l = mk();
  submit(l, 'guard', 'content');
  l.transition('guard', 'reserved');
  l.transition('guard', 'push_started');
  assert.equal(l.terminal('guard', 'finish', { summary: 'premature' }).error, 'hook_unobserved');
  handleHook(l, 's', 'UserPromptSubmit', { prompt: 'private-secret-987', session_id: 'owner' });
  handleHook(l, 's', 'Stop', { last_assistant_message: 'private-answer-456' });
  decidePermission(l, { request_id: 'secret-test', tool_name: 'Bash', input_preview: 'private-command-123' });
  assert.ok(!fs.readFileSync(l.p.ledger, 'utf8').includes('private-secret-987'));
  assert.ok(!fs.readFileSync(l.p.ledger, 'utf8').includes('private-answer-456'));
  assert.ok(!fs.readFileSync(l.p.ledger, 'utf8').includes('private-command-123'));
  handleHook(l, 's', 'UserPromptSubmit', { prompt: chan('guard'), session_id: 'session' });
  assert.equal(l.state('guard').observed, true);
  assert.equal(l.terminal('guard', 'finish', { summary: 'legitimate' }).ok, true);
  assert.equal(l.state('guard').receipt.summary, 'legitimate');
  assert.equal(fs.statSync(l.p.ledger).mode & 0o777, 0o600);
  assert.equal(fs.statSync(l.p.inbox).mode & 0o777, 0o700);
});
