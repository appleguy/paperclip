import { describe, expect, it } from 'vitest';
import { claudeGoal, codexGoal } from './nar-goal.js';

describe('NAR native goals', () => {
  it('initializes Codex and sends goal operations to the exact thread, closing on errors', async () => {
    const calls: unknown[] = [];
    const rpc = { request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return { goal: null }; }, notify: (m: string) => { calls.push(m); }, close: async () => { calls.push('close'); } };
    for (const action of ['set', 'get', 'clear'] as const) await codexGoal(action, 'thread', action === 'set' ? 'finish' : undefined, rpc);
    expect(calls.filter(x => Array.isArray(x) && x[0].startsWith('thread/goal/'))).toEqual([
      ['thread/goal/set', { threadId: 'thread', objective: 'finish', status: 'active' }], ['thread/goal/get', { threadId: 'thread' }], ['thread/goal/clear', { threadId: 'thread' }],
    ]);
    expect(calls.filter(x => x === 'close')).toHaveLength(3);
    await expect(codexGoal('get', 'thread', undefined, { ...rpc, request: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
    expect(calls.at(-1)).toBe('close');
  });
  it('records and reads desired Claude state without claiming live delivery', async () => {
    const files = new Map<string, string>();
    const storage = { readFile: async (p: any) => { if (!files.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(p)!; }, mkdir: async () => undefined, writeFile: async (p: any, data: any) => { files.set(p, data); }, rename: async (from: any, to: any) => { files.set(to, files.get(from)!); files.delete(from); } } as any;
    const seat = { harness: 'claude' as const, cwd: '/', goalFile: '/goals/test.json' };
    expect(await claudeGoal('get', seat, undefined, storage)).toMatchObject({ desired: null });
    expect(await claudeGoal('set', seat, 'finish', storage)).toMatchObject({ desired: { action: 'set', text: 'finish' } });
    expect(await claudeGoal('get', seat, undefined, storage)).toMatchObject({ action: 'set', text: 'finish' });
    await claudeGoal('clear', seat, undefined, storage);
    expect(await claudeGoal('get', seat, undefined, storage)).toMatchObject({ action: 'clear' });
  });
});
