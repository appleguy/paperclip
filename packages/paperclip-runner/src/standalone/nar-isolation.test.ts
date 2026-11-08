import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// @ts-expect-error JS shared helper
import { assembleGuidance } from '../../scripts/nar-guidance.mjs';
// @ts-expect-error JS shared helper
import { claudeResumeArgs, claudeStartArgs } from '../../scripts/nar-claude-args.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
describe('standalone isolation', () => {
  it('assembles exactly owner-only or the selected class, and rejects unknown classes', () => {
    expect(assembleGuidance()).toBe(readFileSync('/Volumes/NVM/Guidance/owner-rules.md', 'utf8'));
    // Worker classes carry the lean worker layer; only coordinators carry the whole owner-rules file.
    expect(assembleGuidance('research')).toContain('# Worker rules');
    expect(assembleGuidance('research')).not.toContain(readFileSync('/Volumes/NVM/Guidance/owner-rules.md', 'utf8').trim());
    expect(assembleGuidance('coordinator')).toContain(readFileSync('/Volumes/NVM/Guidance/owner-rules.md', 'utf8').trim());
    expect(() => assembleGuidance('bogus')).toThrow();
    expect(() => assembleGuidance(undefined, '/tmp')).toThrow();
  });
  it('locks down Claude CLI sources', () => {
    const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
    const worker = claudeResumeArgs('id', 'clean', '/goal x', { name: 'w1', model: 'sonnet', effort: 'medium' });
    expect(worker.slice(0, 2)).toEqual(['--setting-sources', '']);
    expect(after(worker, '--mcp-config')).toBe('{"mcpServers":{}}');
    expect(worker).not.toContain('--disable-slash-commands');
    expect(after(worker, '--disallowedTools').split(',')).toEqual(expect.arrayContaining(['Agent', 'SendMessage', 'CronCreate', 'ToolSearch']));
    expect(worker.slice(-3)).toEqual(['--resume', 'id', '/goal x']);
    expect(after(worker, '--remote-control')).toBe('w1');
    expect(claudeResumeArgs('id', '', undefined)).toContain('--disable-slash-commands');
    const lead = claudeStartArgs({ sessionId: 's', name: 'lead', model: 'opus', effort: 'high', extraGuidance: 'g', prompt: 'p', klass: 'coordinator' });
    const leadDenied = after(lead, '--disallowedTools').split(',');
    expect(leadDenied).toContain('Agent');
    expect(leadDenied).not.toContain('CronCreate');
    expect(leadDenied).not.toContain('SendMessage');
    expect(after(lead, '--session-id')).toBe('s');
  });
  it('has no forbidden dependency anywhere in the local import graph', () => {
    const pending = ['scripts/run-standalone-codex.mjs', 'scripts/nar-goal.mjs', 'scripts/nar-claude-resume.mjs'].map(p => resolve(root, p));
    const seen = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(file).not.toMatch(/\/(?:server|packages\/db)\//);
      const source = readFileSync(file, 'utf8');
      const imports = source.matchAll(/(?:\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?|\bimport\s*\(|\brequire\s*\()(['"])([^'"]+)\1/g);
      for (const imp of imports) {
        const spec = imp[2]!;
        expect(spec, `${file} imports ${spec}`).not.toMatch(/(?:@paperclipai\/(?:db|server|api-client)|(?:^|\/)server\/|packages\/db\/|paperclip.*(?:api-client|client-api))/i);
        if (spec.startsWith('.')) {
          const path = resolve(dirname(file), spec);
          const candidates = extname(path) === '.js' ? [path.slice(0, -3) + '.ts', path] : [path, path + '.ts', path + '.js', resolve(path, 'index.ts')];
          const found = candidates.find(existsSync);
          if (!found) throw new Error(`unresolved ${spec} from ${file}`);
          pending.push(found);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});
