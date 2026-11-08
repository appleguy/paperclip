import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from './run-standalone-opencode.mjs';

const tmp = '/Volumes/NVM/AI_Agent_Runtime/tmp';
test('persists binding before the NAR attempt and preserves guidance in turn text', async () => {
  const dir = mkdtempSync(join(tmp, 'nar-oc-test-'));
  const args = ['--server-url','http://127.0.0.1:19414','--password-file','/tmp/password','--model','p/m',
    '--cwd',tmp,'--receipt-dir',dir,'--name','qwen-lane','--prompt','class guidance\ntask'];
  await main(args, async input => {
    assert.equal(input.prompt, 'class guidance\ntask');
    assert.equal(input.requireBindingCheckpoint, true);
    assert.equal(JSON.parse(readFileSync(input.configPath)).url, 'http://127.0.0.1:19414');
    await input.onBound({ sessionId: 'ses-test', messageId: 'msg-test', kind: 'submit' });
    assert.match(readFileSync(join(dir, 'receipt.jsonl'), 'utf8'), /"phase":"bound"/);
    return { proc: { exitCode: 0 }, parsed: { sessionId: 'ses-test' }, possibleWork: true };
  });
  const journal = readFileSync(join(dir, 'receipt.jsonl'), 'utf8');
  assert.match(journal, /"guidance":"turn-text"/); assert.match(journal, /"phase":"result"/);
  await assert.rejects(main(args, async () => { throw Error('must not replay'); }), /EEXIST/);
});
test('rejects remote endpoints before provider contact', async () => {
  await assert.rejects(main(['--server-url','http://example.com:19414','--password-file','/tmp/p','--model','p/m','--cwd',tmp,
    '--receipt-dir',tmp,'--name','test','--prompt','x'], async () => { throw Error('called'); }), /loopback/);
});
