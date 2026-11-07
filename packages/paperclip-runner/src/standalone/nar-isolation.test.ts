import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// @ts-expect-error JS shared helper
import { assembleGuidance } from '../../scripts/nar-guidance.mjs';
// @ts-expect-error JS shared helper
import { claudeResumeArgs } from '../../scripts/nar-claude-args.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
describe('standalone isolation', () => {
  it('assembles exactly owner-only or the selected class, and rejects unknown classes', () => {
    expect(assembleGuidance()).toBe(readFileSync('/Volumes/NVM/Guidance/owner-rules.md', 'utf8'));
    expect(assembleGuidance('research')).toContain(readFileSync('/Volumes/NVM/Guidance/owner-rules.md', 'utf8').trim());
    expect(() => assembleGuidance('bogus')).toThrow();
    expect(() => assembleGuidance(undefined, '/tmp')).toThrow();
  });
  it('locks down Claude CLI sources', () => {
    expect(claudeResumeArgs('id', 'clean', '/goal x')).toEqual(['--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt-snapshot', 'off', '--append-system-prompt', 'clean', '--resume', 'id', '/goal x']);
    expect(claudeResumeArgs('id', '', undefined)).toEqual(['--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--system-prompt-snapshot', 'off', '--resume', 'id']);
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
