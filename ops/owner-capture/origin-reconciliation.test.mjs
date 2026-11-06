import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = process.env.OWNER_GUARD_TEST_SCRIPT ?? fileURLToPath(new URL('./owner-guard', import.meta.url));
function fixture() {
  const dir = mkdtempSync('/Volumes/NVM/AI_Agent_Runtime/tmp/sco1008-');
  const env = { PATH: process.env.PATH, HOME: dir, OWNER_GUARD_STATE: dir, OWNER_GUARD_PID: String(process.pid), OWNER_GUARD_PC: path.join(dir, 'pc') };
  const run = (args, input = '') => execFileSync('/bin/sh', [guard, ...args], { input, env, encoding: 'utf8' });
  return { dir, env, run };
}
test('source provenance distinguishes peer and harness from owner steering', () => {
  const f = fixture(); const tr = path.join(f.dir, 'rollout-test.jsonl');
  const peer = '[msg:b064bb92] SCO-1187:\nPeer report.\n\n<!-- batch-id:a8eef9ec -->';
  const row = (id, text, client, origin) => ({ timestamp: '2026-01-01T00:00:00Z', type: 'response_item', metadata: { client_authored: client }, payload: { id, type: 'message', role: 'user', internal_chat_message_metadata_passthrough: { turn_id: `turn-${id}`, content_item_metadata: [{ provenance: { type: origin } }] }, content: [{ type: 'input_text', text }] } });
  const rows = [row('peer', peer, false, 'user'), row('harness', '# AGENTS.md\nInjected role', false, 'agents_md'), row('owner1', '# AGENTS.md\nPlease change this rule', true, 'user'), row('owner2', peer, true, 'user'), row('owner3', 'Please change this rule', true, 'user'), row('owner4', 'Please change this rule', true, 'user')];
  writeFileSync(tr, [JSON.stringify({ type: 'session_meta', payload: { id: 'seat', source: 'cli', cwd: f.dir } }), ...rows.map(JSON.stringify)].join('\n') + '\n');
  const scanned = f.run(['scan', tr]).trim().split('\n').map(JSON.parse);
  assert.deepEqual(scanned.map(x => x.event), ['message:peer', 'message:owner1', 'message:owner2', 'message:owner3', 'message:owner4']);
  f.run(['capture'], JSON.stringify({ session_id: 'seat', transcript_path: tr, turn_id: 'turn-harness', prompt: '# AGENTS.md\nInjected role' }));
  assert.equal(f.run(['list']), '');
  f.run(['_ledger_add', ''], scanned.map(JSON.stringify).join('\n') + '\n');
  const first = JSON.parse(f.run(['list']).split('\n')[0]); f.run(['close', first.id, 'answered']);
  f.run(['_ledger_add', ''], scanned.map(JSON.stringify).join('\n') + '\n');
  assert.equal(f.run(['list']).trim().split('\n').length, 4);
});
test('later dropped closure supersedes an earlier watch without rewriting history', () => {
  const f = fixture(); mkdirSync(path.join(f.dir, 'open'));
  const file = path.join(f.dir, 'open/seat.jsonl');
  const lines = [{id:'seat:one',sid:'seat',ts:'2026-01-01T00:00:00Z',text:'peer receipt'}, {id:'seat:one',close:'SCO-1',ts:'2026-01-01T00:00:01Z'}, {id:'seat:one',watch:'SCO-1',ts:'2026-01-01T00:00:02Z'}, {id:'seat:one',close:'dropped peer',ts:'2026-01-01T00:00:03Z'}].map(JSON.stringify).join('\n')+'\n';
  writeFileSync(file, lines); writeFileSync(f.env.OWNER_GUARD_PC, '#!/bin/sh\nprintf "{\\"status\\":\\"cancelled\\"}"\n', {mode:0o755});
  assert.equal(f.run(['watch-check']), ''); assert.equal(readFileSync(file, 'utf8'), lines);
});
test('managed sessions do not adopt another agent or unattributed legacy record', () => {
  const f = fixture(); f.env.PAPERCLIP_AGENT_ID = 'agent-a';
  f.run(['capture'], JSON.stringify({ session_id:'seat-a', cwd:f.dir, message_id:'one', prompt:'Owner direction' }));
  f.env.PAPERCLIP_AGENT_ID = 'agent-b';
  assert.equal(f.run(['resume'], JSON.stringify({session_id:'seat-b',cwd:f.dir})), '');
  f.env.PAPERCLIP_AGENT_ID = 'agent-a';
  assert.match(f.run(['resume'], JSON.stringify({session_id:'seat-c',cwd:f.dir})), /Owner direction/);
});
test('non-owner correction appends provenance and prevents stale watch or replay from reopening', () => {
  const f = fixture(); mkdirSync(path.join(f.dir, 'open'));
  const file = path.join(f.dir, 'open/seat.jsonl');
  const lines = [{id:'seat:one',sid:'seat',event:'message:one',ts:'2026-01-01T00:00:00Z',text:'peer receipt'}, {id:'seat:one',close:'SCO-1',ts:'2026-01-01T00:00:01Z'}, {id:'seat:one',watch:'SCO-1',ts:'2026-01-01T00:00:02Z'}].map(JSON.stringify).join('\n')+'\n';
  writeFileSync(file, lines); f.env.PAPERCLIP_AGENT_ID = 'agent'; f.env.PAPERCLIP_RUN_ID = 'run';
  assert.throws(() => f.run(['correct-non-owner', 'seat', 'peer receipt']));
  f.run(['correct-non-owner', 'seat:one', 'verified peer receipt']);
  const corrected = readFileSync(file, 'utf8'); assert.ok(corrected.startsWith(lines));
  const event = JSON.parse(corrected.trim().split('\n').at(-1));
  assert.equal(event.disposition, 'non-owner'); assert.equal(event.agent, 'agent'); assert.equal(event.run, 'run');
  f.run(['correct-non-owner', 'seat:one', 'verified peer receipt']); assert.equal(readFileSync(file, 'utf8'), corrected);
  appendFileSync(file, JSON.stringify({id:'seat:one',watch:'SCO-1',ts:'2026-01-01T00:00:04Z'})+'\n'+JSON.stringify({id:'seat:one',reopen:'stale race',ts:'2026-01-01T00:00:05Z'})+'\n');
  f.run(['_ledger_add', ''], JSON.stringify({sid:'seat',event:'message:one',ts:'2026-01-01T00:00:00Z',text:'peer receipt'})+'\n');
  assert.equal(f.run(['list']), ''); assert.equal(f.run(['watch-check']), '');
});
