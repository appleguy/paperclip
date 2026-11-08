#!/usr/bin/env node
// Standalone observer/controller for an existing OpenCode server. No server is spawned.
import { existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

export async function main(args, runAttempt) {
  const { values: v } = parseArgs({ args, options: {
    'server-url': { type: 'string' }, 'password-file': { type: 'string' }, model: { type: 'string' },
    cwd: { type: 'string' }, 'receipt-dir': { type: 'string' }, name: { type: 'string' },
    prompt: { type: 'string' }, 'timeout-sec': { type: 'string' },
  } });
  for (const k of ['server-url', 'password-file', 'model', 'cwd', 'receipt-dir', 'name', 'prompt'])
    if (!v[k]?.trim()) throw new Error(`--${k} is required`);
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(v['server-url'])) throw new Error('server URL must be loopback');
  if (!isAbsolute(v['password-file']) || !isAbsolute(v['receipt-dir'])) throw new Error('password file and receipt directory must be absolute');
  const timeoutSec = Number(v['timeout-sec'] ?? '0');
  if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 0 || timeoutSec > 86400) throw new Error('invalid timeout');
  const cwd = await realpath(v.cwd);
  const id = `oc-${randomBytes(8).toString('hex')}`;
  mkdirSync(v['receipt-dir'], { recursive: true, mode: 0o700 });
  const journal = openSync(join(v['receipt-dir'], 'receipt.jsonl'), 'wx', 0o600);
  const receipt = value => { writeSync(journal, JSON.stringify(value) + '\n'); fsyncSync(journal); };
  const cfg = join(v['receipt-dir'], 'server.json');
  const abort = new AbortController();
  const detach = () => abort.abort();
  process.once('SIGINT', detach); process.once('SIGTERM', detach);
  try {
    writeFileSync(cfg, JSON.stringify({ url: v['server-url'], passwordFile: v['password-file'] }), { flag: 'wx', mode: 0o600 });
    receipt({ phase: 'manifest', id, name: v.name, cwd, model: v.model, server: v['server-url'], guidance: 'turn-text' });
    const result = await runAttempt({ configPath: cfg, agentId: v.name, taskId: id, runId: id, cwd, model: v.model,
      title: v.name, prompt: v.prompt, timeoutSec, signal: abort.signal, requireBindingCheckpoint: true,
      onBound: async binding => receipt({ phase: 'bound', ...binding }),
      onLog: async (stream, chunk) => { receipt({ phase: 'log', stream, chunk }); (stream === 'stdout' ? process.stdout : process.stderr).write(chunk); },
    });
    receipt({ phase: 'result', exitCode: result.proc.exitCode, possibleWork: result.possibleWork,
      recovery: result.executionRecovery, termination: result.providerTermination, sessionId: result.parsed.sessionId });
    if (result.proc.exitCode !== 0) throw new Error(`OpenCode turn not completed (exit ${result.proc.exitCode}); inspect receipt before any retry`);
  } finally {
    process.removeListener('SIGINT', detach); process.removeListener('SIGTERM', detach); closeSync(journal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  register();
  const root = new URL('../../adapters/opencode-local/src/', import.meta.url).href;
  registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(source))) return next(source.href, context);
    }
    return next(specifier, context);
  } });
  try {
    const { runNarOpenCodeAttempt } = await import('../../adapters/opencode-local/src/server/nar/nar-attempt.ts');
    await main(process.argv.slice(2), runNarOpenCodeAttempt);
  } catch (error) { console.error(error instanceof Error ? error.message : 'standalone OpenCode failed'); process.exitCode = 1; }
}
