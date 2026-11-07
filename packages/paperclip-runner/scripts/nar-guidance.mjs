import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = '/Volumes/NVM/Guidance';
const classes = new Set(['coordinator', 'coding', 'research', 'web', 'local']);
/** Only the explicit Guidance rewrite is admitted; never discover harness instructions. */
export function assembleGuidance(klass, project) {
  if (!klass) {
    if (project) throw new Error('--project requires --class');
    return readFileSync(join(root, 'owner-rules.md'), 'utf8');
  }
  if (!classes.has(klass)) throw new Error('invalid guidance class');
  const dir = join(root, 'cmd/guide');
  const binary = join(dir, 'guide');
  if (!existsSync(binary)) execFileSync('go', ['build', '-o', binary, '.'], { cwd: dir, stdio: 'inherit' });
  return execFileSync(binary, ['assemble', '--class', klass, ...(project ? ['--project', project] : []), '--cat'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
