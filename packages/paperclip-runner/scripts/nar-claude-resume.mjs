#!/usr/bin/env node
// Explicit restart path: never interacts with an existing terminal or starts automatically.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { assembleGuidance } from './nar-guidance.mjs';
import { claudeResumeArgs } from './nar-claude-args.mjs';
const registryPath = '/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/nar-goal-seats.json';
const { values } = parseArgs({ args: process.argv.slice(2), options: { seat: { type: 'string' }, class: { type: 'string' }, project: { type: 'string' } } });
if (!values.seat) throw new Error('usage: nar-claude-resume.mjs --seat NAME [--class CLASS] [--project PATH]');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const seat = Object.hasOwn(registry, values.seat) ? registry[values.seat] : null;
if (!seat || seat.harness !== 'claude' || !/^[0-9a-f-]{36}$/i.test(seat.sessionId) || !seat.cwd?.startsWith('/') || !seat.goalFile?.startsWith('/')) throw new Error('invalid Claude seat');
let desired;
try { desired = JSON.parse(await readFile(seat.goalFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let prompt;
if (desired?.action === 'clear') prompt = '/goal clear';
else if (desired?.action === 'set' && typeof desired.text === 'string' && desired.text.trim() && !/[\r\n]/.test(desired.text) && desired.text.trim().toLowerCase() !== 'clear') prompt = `/goal ${desired.text}`;
else if (desired) throw new Error('invalid desired goal file');
console.error('Resume only after stopping the existing Claude session; prior conversation history may contain old guidance.');
const ownerRules = (await readFile('/Volumes/NVM/Guidance/owner-rules.md', 'utf8')).trim();
// Resume re-injects the seat's registered class assembly (default coding), never the whole owner-rules file.
const guidance = assembleGuidance(values.class ?? seat.class ?? 'coding', values.project ?? seat.project).replace(ownerRules, '').trim();
const child = spawn('claude', claudeResumeArgs(seat.sessionId, guidance, prompt, { name: values.seat, model: seat.model, effort: seat.effort }), { cwd: seat.cwd, stdio: 'inherit', env: { ...process.env, PAPERCLIP_NAR_LAUNCH: '1' } });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
