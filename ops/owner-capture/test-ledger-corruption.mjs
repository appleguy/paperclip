// Offline F06 regression. No live ledger, network, session or credential use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const guard = process.env.OWNER_GUARD_TEST_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-guard');
const root = fs.mkdtempSync('/Volumes/NVM/AI_Agent_Runtime/tmp/owner-ledger-f06-');
const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const record = sid => JSON.stringify({id:`${sid}:abc123`,sid,ts,text:`Keep ${sid}`,cwd:root,proc:'',src:'test'})+'\n';
function run(state, args, input = '') {
  const r = spawnSync('/bin/sh', [guard, ...args], {
    encoding:'utf8', input, timeout:15000,
    env:{PATH:process.env.PATH, HOME:root, OWNER_GUARD_STATE:state,
      OWNER_GUARD_SEATS:path.join(root,'no-seats'), OWNER_GUARD_PID:String(process.pid)}
  });
  assert.ifError(r.error);
  return r;
}
for (const kind of ['tail','middle','shape','many','all','unterminated-valid']) {
  const state = path.join(root,kind), open = path.join(state,'open');
  fs.mkdirSync(open,{recursive:true});
  fs.writeFileSync(path.join(open,'seat-a.jsonl'),record('seat-a')+
    JSON.stringify({id:'seat-a:abc123',event:'message:alias',reconciled:true})+'\n'+
    JSON.stringify({id:'seat-a:abc123',ts:ts.replace('Z','.000Z'),adopt:'seat-a'})+'\n');
  const bad = path.join(open,'seat-b.jsonl');
  let bytes;
  if (kind === 'tail') bytes = record('seat-b')+'{"id":';
  if (kind === 'middle') bytes = record('seat-b')+'broken\n'+record('seat-c');
  if (kind === 'shape') bytes = record('seat-b')+'null\n[]\n{"id":4}\n';
  if (kind === 'many') bytes = record('seat-b')+'broken\n'.repeat(1000);
  if (kind === 'all') bytes = '{"id":';
  if (kind === 'unterminated-valid') bytes = record('seat-b').trimEnd();
  fs.writeFileSync(bad,bytes);
  const listed = run(state,['list']);
  assert.equal(listed.status,0,listed.stderr);
  const rows = listed.stdout.trim().split('\n').map(JSON.parse);
  assert(rows.some(r=>r.sid==='seat-a' && !r._ledger_unknown));
  if (kind !== 'all') assert(rows.some(r=>r.sid==='seat-b' && !r._ledger_unknown));
  if (kind === 'middle') assert(rows.some(r=>r.sid==='seat-c'));
  const damaged = kind !== 'unterminated-valid';
  assert.equal(rows.filter(r=>r._ledger_unknown).length,damaged?1:0);
  assert.equal(listed.stderr.includes('state unknown'),damaged);
  assert(listed.stderr.length<350,'diagnostic must remain bounded');
  const gate = run(state,['gate'],JSON.stringify({session_id:'seat-a'}));
  assert.equal(gate.status,0,gate.stderr);
  assert.equal(JSON.parse(gate.stdout).decision,'block');
  if (damaged) {
    const unknown = run(state,['gate'],JSON.stringify({session_id:'unrelated'}));
    assert.equal(JSON.parse(unknown.stdout).decision,'block');
    const resumed = run(state,['resume'],JSON.stringify({session_id:'unrelated',cwd:root}));
    assert(resumed.stdout.includes('owner state is unknown'));
    assert.notEqual(run(state,['close',rows.find(r=>r._ledger_unknown).id,'answered']).status,0);
  }
  assert.equal(fs.readFileSync(bad,'utf8'),bytes,'damaged originals must remain byte-for-byte intact');
  assert.equal(run(state,['close','seat-a:abc123','answered']).status,0);
  const after = run(state,['list']);
  assert(!after.stdout.includes('"id":"seat-a:abc123"'));
  if (damaged) assert(after.stdout.includes('"_ledger_unknown":true'));
  // Explicit repair is the only way to clear the unknown state.
  fs.writeFileSync(bad,record('seat-b'));
  const repaired = run(state,['gate'],JSON.stringify({session_id:'unrelated'}));
  assert.equal(repaired.stdout,'');
  assert.equal(repaired.stderr,'');
  console.log(`PASS ${kind}`);
}
const empty = run(path.join(root,'empty'),['list']);
assert.equal(empty.status,0); assert.equal(empty.stdout,''); assert.equal(empty.stderr,'');
console.log(`PASS empty; fixtures retained at ${root} (archive with task evidence; no automatic text deletion)`);
