import { readFile, mkdir, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { SharedDaemonCodexAppServerTransport } from '../drivers/codex/shared-daemon-transport.js';

export const registryPath = '/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context/nar-goal-seats.json';
export type Seat = { harness: 'codex' | 'claude'; cwd: string; sessionId?: string; threadId?: string; threadFile?: string; codexHome?: string; goalFile?: string };
type Action = 'set' | 'get' | 'clear';
type Rpc = { request(method: string, params: Record<string, unknown>): Promise<unknown>; notify(method: string): void; close(): Promise<void> };
export async function codexGoal(action: Action, threadId: string, text: string | undefined, client: Rpc) {
  try {
    await client.request('initialize', { clientInfo: { name: 'nar-goal', version: '1' }, capabilities: { experimentalApi: true } });
    client.notify('initialized');
    const params: Record<string, unknown> = { threadId };
    if (action === 'set') { params.objective = text; params.status = 'active'; }
    return await client.request(`thread/goal/${action}`, params);
  } finally { await client.close(); }
}
export async function claudeGoal(action: Action, seat: Seat, text: string | undefined, storage = { readFile, mkdir, writeFile, rename }) {
  if (!seat.goalFile || !isAbsolute(seat.goalFile)) throw new Error('Claude seat needs an absolute goalFile');
  if (action === 'get') {
    try { return { delivery: 'restart-only; desired state, not native observation', ...JSON.parse(await storage.readFile(seat.goalFile, 'utf8')) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { delivery: 'restart-only; native state unknown', desired: null }; throw error; }
  }
  const desired = action === 'set' ? { action, text } : { action };
  await storage.mkdir(dirname(seat.goalFile), { recursive: true, mode: 0o700 });
  const tmp = `${seat.goalFile}.${randomUUID()}.tmp`;
  await storage.writeFile(tmp, JSON.stringify(desired) + '\n', { mode: 0o600, flag: 'wx' });
  await storage.rename(tmp, seat.goalFile);
  return { delivery: 'queued for explicit NAR resume; not applied to live session', desired };
}
export async function loadSeat(name: string, harness?: string, file = registryPath): Promise<Seat> {
  const registry = JSON.parse(await readFile(file, 'utf8')) as Record<string, Seat>;
  let seat = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!seat && harness === 'codex' && /^[0-9a-f-]{36}$/i.test(name)) seat = { harness: 'codex', cwd: process.cwd(), threadId: name };
  if (!seat || !['codex', 'claude'].includes(seat.harness) || !seat.cwd || !isAbsolute(seat.cwd)) throw new Error('unknown or invalid seat');
  if (harness && harness !== seat.harness) throw new Error('harness does not match registry');
  return seat;
}
export async function main(args: string[]) {
  const action = args.shift() as Action;
  if (!['set', 'get', 'clear'].includes(action)) throw new Error('usage: nar-goal.mjs set|get|clear --seat NAME [--harness codex|claude] [--text TEXT | --file PATH]');
  const { values, positionals } = parseArgs({ args, options: { seat: { type: 'string' }, harness: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' } }, allowPositionals: true });
  if (positionals.length || !values.seat || (values.harness && !['codex', 'claude'].includes(values.harness)) || (values.text !== undefined && values.file !== undefined) || (action !== 'set' && (values.text !== undefined || values.file !== undefined))) throw new Error('invalid arguments');
  const text = values.file !== undefined ? (await readFile(values.file, 'utf8')).trim() : values.text?.trim();
  if (action === 'set' && (!text || /[\r\n]/.test(text) || text.toLowerCase() === 'clear')) throw new Error('goal must be nonempty, single-line, and not "clear"');
  const seat = await loadSeat(values.seat, values.harness);
  if (seat.harness === 'claude') return claudeGoal(action, seat, text);
  const threadId = seat.threadFile ? (await readFile(seat.threadFile, 'utf8')).trim() : seat.threadId;
  if (!threadId || !/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('invalid or empty Codex thread id');
  const codexHome = resolve(seat.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const socketPath = await realpath(join(codexHome, 'app-server-control', 'app-server-control.sock'));
  const socket = await stat(socketPath); if (!socket.isSocket()) throw new Error('Codex control path is not a socket');
  const generation = `${socket.dev}:${socket.ino}:${socket.birthtimeMs}`;
  const client = new SharedDaemonCodexAppServerTransport({ identity: { codexHome, socketPath, cliVersion: 'not-invoked', appServerVersion: 'see-initialize', processGeneration: generation, threadId, workspace: seat.cwd, model: 'goal-only', effort: 'medium' }, admit: async () => { const s = await stat(socketPath); return s.isSocket() && `${s.dev}:${s.ino}:${s.birthtimeMs}` === generation; } });
  return codexGoal(action, threadId, text, client);
}
