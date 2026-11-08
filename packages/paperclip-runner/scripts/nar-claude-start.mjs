#!/usr/bin/env node
// Start a fresh NAR Claude seat with Remote Control and register it so nar-claude-resume.mjs can restart it.
// Run it inside the pane that should host the seat; it never types into an existing terminal.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { assembleGuidance } from './nar-guidance.mjs';
import { claudeStartArgs } from './nar-claude-args.mjs';
const registryPath = '/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/nar-goal-seats.json';
const goalDir = '/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/nar-goals';
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  seat: { type: 'string' }, cwd: { type: 'string' }, 'prompt-file': { type: 'string' },
  model: { type: 'string', default: 'sonnet' }, effort: { type: 'string', default: 'medium' },
  class: { type: 'string' }, project: { type: 'string' },
  replace: { type: 'boolean' }, 'allow-opus': { type: 'boolean' } } });
if (!values.seat || !/^[a-z0-9][a-z0-9-]*$/.test(values.seat) || !values.cwd?.startsWith('/') || !values['prompt-file'])
  throw new Error('usage: nar-claude-start.mjs --seat NAME --cwd ABS --prompt-file FILE [--model sonnet] [--effort medium] [--class C] [--project P] [--replace] [--allow-opus]');
// --allow-opus is only for relaunching a lead that already runs Opus (zagent_relaunch_lead.py); workers never get it.
if (/opus/i.test(values.model) && !values['allow-opus']) throw new Error('Opus is not allowed for worker seats');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
if (Object.hasOwn(registry, values.seat) && !values.replace) throw new Error(`seat ${values.seat} exists; use nar-claude-resume.mjs, or --replace for a fresh session under the same name`);
const prompt = (await readFile(values['prompt-file'], 'utf8')).trim();
const ownerRules = (await readFile('/Volumes/NVM/Guidance/owner-rules.md', 'utf8')).trim();
// A seat always gets a class assembly (default coding); no class used to mean the whole owner-rules file.
const klass = values.class ?? 'coding';
const extraGuidance = assembleGuidance(klass, values.project).replace(ownerRules, '').trim();
const sessionId = randomUUID();
registry[values.seat] = { harness: 'claude', sessionId, cwd: values.cwd, goalFile: `${goalDir}/${values.seat}.json`, model: values.model, effort: values.effort, class: klass, ...(values.project ? { project: values.project } : {}) };
await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
const args = claudeStartArgs({ sessionId, name: values.seat, model: values.model, effort: values.effort, extraGuidance, prompt });
const child = spawn('claude', args, { cwd: values.cwd, stdio: 'inherit', env: { ...process.env, PAPERCLIP_NAR_LAUNCH: '1' } });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
