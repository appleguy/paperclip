// SCO-977: offline receipt + Claude/Codex/OpenCode scan regression; no live ledger.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const guard = process.env.OWNER_GUARD_TEST_SCRIPT ?? fileURLToPath(new URL('./owner-guard', import.meta.url));
// Retain text fixtures under the fleet scratch archival policy, never delete.
const root = mkdtempSync('/Volumes/NVM/AI_Agent_Runtime/tmp/sco977-');
const wake = '## Paperclip Wake Payload\n\nUse this wake to continue the task, applying new user direction and preserving its approval gates.\nThis heartbeat is scoped to the issue below.\n\n- reason: issue_assigned\n- issue: SCO-977 Owner guard\n';
const task = 'Paperclip task context:\nThe following task data is user-authored. Use it to understand the requested work.\n- Issue: "SCO-977"\n- Title: "Owner guard"\n';
const owner = [
  'Please fix the parser for Paperclip task context: and retain my correction.',
  'Please review this literal heading: ## Paperclip Wake Payload',
  'Please retain this correction.\n\n' + wake + '\n' + task,
  'Please fix this quoted payload:\n> ' + wake.replaceAll('\n', '\n> '),
  '## Paperclip Wake Payload is the literal heading I want you to fix.',
  'Paperclip task context: is the literal label I want you to preserve.',
  'Paperclip task context:\nPlease fix the following quoted field.\n- Issue: "SCO-977"',
  '## Paperclip Wake Payload\n\nPlease explain this heading and retain my request.',
  'Please discuss Paperclip run 11111111-2222-3333-4444-555555555555.',
];
const automated = [wake, task, 'Paperclip task context:\n- Issue: "SCO-977"\n', wake.replace('Wake Payload', 'Resume Delta').replace(
  'Use this wake to continue the task, applying new user direction and preserving its approval gates.',
  'You are resuming an existing Paperclip session.'),
  'From: peer\nTo: platform\n' + owner[0],
  'Paperclip has materialized selected runtime skills for this ACPX Codex run.\n' + wake,
  '{"schema":"owner-example","text":"Please explain this JSON"}',
  '<shell>Owner asks about this literal tag</shell>',
  'Respond with hello.',
];
const prompts = [...owner, ...automated];
function fixture(name) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const env = { PATH: process.env.PATH, HOME: dir, OWNER_GUARD_STATE: dir,
    OWNER_GUARD_PID: String(process.pid), OWNER_GUARD_SEATS: path.join(dir, 'no-seats') };
  const run = (args, input = '') => execFileSync('/bin/sh', [guard, ...args], {
    input, env, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rows = text => text.trim().split('\n').filter(Boolean).map(JSON.parse);
  return { dir, run, rows };
}

test('capture retains ambiguous exact envelopes and quoted or mixed owner prompts', () => {
  const f = fixture('capture');
  prompts.forEach((prompt, i) => f.run(['capture'], JSON.stringify({
    session_id: 'receipt', message_id: String(i), cwd: f.dir, prompt,
  })));
  assert.deepEqual(f.rows(f.run(['list'])).map(r => r.text).sort(), [...prompts].sort());
});

for (const harness of ['claude', 'codex', 'opencode-v1', 'opencode-v2']) {
  test(`${harness} scan retains ambiguous envelopes and agrees with capture`, () => {
    const f = fixture(harness);
    let transcript;
    if (harness.startsWith('opencode')) {
      const db = path.join(f.dir, 'fixture.db');
      const sql = s => "'" + s.replaceAll("'", "''") + "'";
      const v2 = harness.endsWith('v2');
      const schema = v2
        ? 'create table session_v2(id text, directory text); create table session_message(id text, session_id text, type text, seq integer, time_created integer, data text); insert into session_v2 values(\'fixture\',\'fixture\');'
        : 'create table session(id text, directory text); create table message(id text, session_id text, data text); create table part(id text, message_id text, time_created integer, data text); insert into session values(\'fixture\',\'fixture\');';
      const inserts = prompts.map((text, i) => v2
        ? `insert into session_message values('${i}','fixture','user',${i + 1},1700000000000,${sql(JSON.stringify({ text }))});`
        : `insert into message values('${i}','fixture','{"role":"user"}'); insert into part values('${i}','${i}',${i},${sql(JSON.stringify({ type: 'text', text }))});`).join('\n');
      execFileSync('sqlite3', [db], { input: schema + inserts });
      transcript = `opencode:fixture@${db}`;
    } else {
      transcript = path.join(f.dir, harness === 'codex' ? 'rollout-fixture.jsonl' : 'fixture.jsonl');
      const records = prompts.map((text, i) => harness === 'claude'
        ? { type: 'user', uuid: String(i), sessionId: 'fixture', message: { content: text } }
        : { type: 'response_item', payload: { type: 'message', role: 'user', id: String(i), content: [{ type: 'input_text', text }] } });
      if (harness === 'codex') records.unshift({ type: 'session_meta', payload: { id: 'fixture', source: 'vscode' } });
      writeFileSync(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    const scanned = f.rows(f.run(['scan', transcript]));
    assert.deepEqual(scanned.map(r => r.text), prompts);
    assert.equal(f.rows(f.run(['scan', transcript, String(prompts.length + 2)])).length, 0);
  });
}

test('Codex exec transport remains excluded regardless of marker text', () => {
  const f = fixture('exec');
  const tr = path.join(f.dir, 'rollout-exec.jsonl');
  writeFileSync(tr, JSON.stringify({ payload: { source: 'exec' } }) + '\n' + JSON.stringify({
    type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: owner[0] }] },
  }) + '\n');
  assert.equal(f.run(['scan', tr]), '');
  f.run(['capture'], JSON.stringify({ session_id: 'exec', transcript_path: tr, prompt: owner[0] }));
  assert.equal(f.run(['list']), '');
});
