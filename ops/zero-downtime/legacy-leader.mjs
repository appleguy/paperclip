// One-time bridge from the pre-lock controller. Reuse the installed upstream
// Postgres client and advisory-lock implementation; stdin lifetime owns it.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = '/Volumes/NVM/Paperclip';
const { createDb, acquireSessionAdvisoryLock } = await import(pathToFileURL(
  root + '/cli/current/node_modules/@paperclipai/db/dist/index.js').href);
const config = JSON.parse(await fs.readFile(root + '/instances/main/config.json', 'utf8'));
if (config.database?.mode !== 'postgres' || !config.database.connectionString) {
  throw new Error('legacy bridge requires the existing external PostgreSQL configuration');
}
const db = createDb(config.database.connectionString);
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(), 2000);
let lock;
try {
  lock = await acquireSessionAdvisoryLock(db, 'paperclip:scheduler-leader', { signal: abort.signal });
} catch (err) {
  if (!abort.signal.aborted) throw err;
  // A legacy payload restored by rollback can already hold this same lock.
  process.stdout.write('scheduler bridge already held\n');
  await db.$client.end({ timeout: 1 });
  process.exit(0);
} finally {
  clearTimeout(deadline);
}
process.stdout.write('scheduler bridge acquired\n');
process.stdin.resume();
await new Promise(resolve => {
  process.stdin.once('end', resolve);
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});
await lock.release();
await db.$client.end({ timeout: 1 });
