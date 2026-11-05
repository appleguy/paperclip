import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const guard = fileURLToPath(new URL('./owner-guard', import.meta.url));
// Retained scratch receipts are covered by the fleet's scratch quarantine policy.
const root = mkdtempSync('/Volumes/NVM/AI_Agent_Runtime/tmp/sco976-');
function fixture(name) {
  const state = path.join(root, name);
  const home = path.join(state, 'home');
  mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, OWNER_GUARD_STATE: state,
    OWNER_GUARD_PID: String(process.pid), OWNER_GUARD_SEATS: path.join(state, 'no-seats'),
    OPENCODE_DB: path.join(state, 'no-opencode.db') };
  const run = (args, input = '') => execFileSync('/bin/sh', [guard, ...args], {
    input, env, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const list = () => run(['list']).trim().split('\n').filter(Boolean).map(JSON.parse);
  const capture = (extra = {}, prompt = 'Please check the queue.') => run(['capture'],
    JSON.stringify({ session_id: name, cwd: state, prompt, ...extra }));
  const close = () => { for (const r of list()) run(['close', r.id, 'answered fixture']); };
  return { state, home, env, run, list, capture, close };
}

test('independent capture calls retain exact and whitespace repeats after closure', () => {
  const f = fixture('unidentified');
  f.capture(); f.close(); f.capture(); f.capture({}, 'Please check  the queue.');
  assert.equal(f.list().length, 2);
});

test('native turn identity dedupes replay even after closure, not repeated text', () => {
  const f = fixture('native');
  f.capture({ message_id: 'one' }); f.capture({ message_id: 'one' });
  assert.equal(f.list().length, 1); f.close();
  f.capture({ message_id: 'one' }); assert.equal(f.list().length, 0);
  f.capture({ message_id: 'two' }); assert.equal(f.list().length, 1);
});

for (const harness of ['claude', 'codex']) {
  test(`${harness}: hook frontier, scan and actual sync reconcile once across closure`, () => {
    const f = fixture(`sync-${harness}`);
    const dir = path.join(f.home, harness === 'claude' ? '.claude/projects/fixture' : '.codex/sessions/fixture');
    mkdirSync(dir, { recursive: true });
    const tr = path.join(dir, harness === 'claude' ? `${path.basename(f.state)}.jsonl` : 'rollout-fixture.jsonl');
    const row = (id) => JSON.stringify(harness === 'claude'
      ? { type: 'user', uuid: id, sessionId: path.basename(f.state), timestamp: new Date().toISOString(),
        message: { content: 'Please check the queue.' } }
      : { type: 'response_item', timestamp: new Date().toISOString(),
        payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text: 'Please check the queue.' }] } }) + '\n';
    writeFileSync(tr, harness === 'claude' ? '' : JSON.stringify({ type: 'session_meta', payload: {
      id: path.basename(f.state), source: 'vscode', cwd: f.state } }) + '\n');
    f.capture({ transcript_path: tr }); f.capture({ transcript_path: tr });
    assert.equal(f.list().length, 1); f.close();
    appendFileSync(tr, row('first'));
    f.run(['sync', '2']); assert.equal(f.list().length, 0);
    // Model output advances the frontier before a distinct identical owner turn.
    appendFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: 'done' } }) + '\n');
    f.capture({ transcript_path: tr }); assert.equal(f.list().length, 1);
    appendFileSync(tr, row('second'));
    f.run(['sync', '2']); f.run(['sync', '2']); assert.equal(f.list().length, 1);
    // Resetting the sync cursor and replaying old rows preserves both closures.
    f.close(); writeFileSync(path.join(f.state, `${harness === 'claude' ? path.basename(f.state) : 'rollout-fixture'}.cursor`), '0');
    f.run(['sync', '2']); assert.equal(f.list().length, 0);
  });

  test(`${harness}: scan-only repeated rows and post-append hook preserve occurrences`, () => {
    const f = fixture(`scan-${harness}`);
    const tr = path.join(f.state, harness === 'claude' ? 'transcript.jsonl' : 'rollout-fixture.jsonl');
    const row = (id) => JSON.stringify(harness === 'claude'
      ? { type: 'user', uuid: id, sessionId: path.basename(f.state), timestamp: new Date().toISOString(), message: { content: 'Please check the queue.' } }
      : { type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text: 'Please check the queue.' }] } }) + '\n';
    writeFileSync(tr, harness === 'claude' ? row('one') : JSON.stringify({ payload: { id: path.basename(f.state), source: 'vscode' } }) + '\n' + row('one'));
    const sync = () => f.run(['_ledger_add', ''], f.run(['scan', tr]));
    sync(); f.close(); sync(); assert.equal(f.list().length, 0);
    appendFileSync(tr, row('two')); sync(); assert.equal(f.list().length, 1);
    f.capture({ transcript_path: tr }); assert.equal(f.list().length, 1);
    f.close(); f.capture({ transcript_path: tr }); assert.equal(f.list().length, 0);
  });
}

test('Steering notes are independent, with optional stable submission identity for retries', () => {
  const f = fixture('steering');
  const note = () => f.run(['note', 'steering-page', 'answered fixture'], 'Please check the queue.').trim();
  assert.notEqual(note(), note());
  assert.equal(f.list().length, 0);
  f.env.OWNER_GUARD_EVENT_ID = 'submission-one';
  const first = f.run(['note', 'steering-page'], 'same').trim();
  assert.equal(f.run(['note', 'steering-page'], 'same').trim(), first);
  assert.equal(f.list().length, 1); f.close();
  f.run(['note', 'steering-page'], 'same'); assert.equal(f.list().length, 0);
  f.env.OWNER_GUARD_EVENT_ID = 'submission-two';
  f.run(['note', 'steering-page'], 'same'); assert.equal(f.list().length, 1);
});

test('OpenCode native message IDs reconcile plugin capture with v2 DB scan', () => {
  const f = fixture('opencode');
  const db = path.join(f.state, 'opencode.db');
  execFileSync('sqlite3', [db, `create table session_v2(id text, directory text);
    create table session_message(id text, session_id text, type text, seq integer, time_created integer, data text);
    insert into session_v2 values('opencode','fixture');
    insert into session_message values('one','opencode','user',1,1700000000000,'{"text":"Please check the queue."}');`]);
  f.capture({ message_id: 'one' }); f.close();
  f.run(['_ledger_add', ''], f.run(['scan', `opencode:opencode@${db}`]));
  assert.equal(f.list().length, 0);
  execFileSync('sqlite3', [db, `insert into session_message values('two','opencode','user',2,1700000000001,'{"text":"Please check the queue."}');`]);
  f.run(['_ledger_add', ''], f.run(['scan', `opencode:opencode@${db}`]));
  assert.equal(f.list().length, 1);
  assert.match(readFileSync(new URL('./opencode/owner-guard.js', import.meta.url), 'utf8'), /message_id: m.id/);
});

test('existing ledger records and closure history remain unchanged', () => {
  const f = fixture('legacy');
  mkdirSync(path.join(f.state, 'open'));
  const file = path.join(f.state, 'open/legacy.jsonl');
  const old = '{"id":"legacy:abcdef","sid":"legacy","text":"Please check the queue.","ts":"2020-01-01T00:00:00Z"}\n{"id":"legacy:abcdef","close":"answered","ts":"2020-01-01T00:00:01Z"}\n';
  writeFileSync(file, old); f.capture({ message_id: 'new' });
  assert.equal(f.list().length, 1); assert.ok(readFileSync(file, 'utf8').startsWith(old));
});
