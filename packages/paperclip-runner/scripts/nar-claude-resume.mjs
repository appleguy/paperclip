#!/usr/bin/env node
// Explicit restart path: never interacts with an existing terminal or starts automatically.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const registryPath = '/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/nar-goal-seats.json';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--seat') throw new Error('usage: nar-claude-resume.mjs --seat NAME');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const seat = Object.hasOwn(registry, args[1]) ? registry[args[1]] : null;
if (!seat || seat.harness !== 'claude' || !/^[0-9a-f-]{36}$/i.test(seat.sessionId) || !seat.cwd?.startsWith('/') || !seat.goalFile?.startsWith('/')) throw new Error('invalid Claude seat');
let desired;
try { desired = JSON.parse(await readFile(seat.goalFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let prompt;
if (desired?.action === 'clear') prompt = '/goal clear';
else if (desired?.action === 'set' && typeof desired.text === 'string' && desired.text.trim() && !/[\r\n]/.test(desired.text) && desired.text.trim().toLowerCase() !== 'clear') prompt = `/goal ${desired.text}`;
else if (desired) throw new Error('invalid desired goal file');
console.error('Resume only after stopping the existing Claude session; desired goal is reapplied on every NAR resume, and is not proof of native state.');
const child = spawn('claude', ['--resume', seat.sessionId, ...(prompt ? [prompt] : [])], { cwd: seat.cwd, stdio: 'inherit' });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
