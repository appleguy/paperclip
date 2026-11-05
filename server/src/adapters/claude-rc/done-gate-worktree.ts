import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { GateDeps } from "./done-gate.js";

/** Porcelain -z quotes nothing; rename/copy records carry a second path. */
export function statusPaths(out: string): string[] {
  const records = out.split("\0"), paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.length < 4) continue;
    paths.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2)) && records[i + 1]) paths.push(records[++i]);
  }
  return paths;
}

/** One index query, bounded open files, streamed contents; never path-sized argv.
 * Missing/unreadable/racing files have no exemption. Index + mode are included
 * so staging a different blob cannot masquerade as unchanged worktree dirt.
 */
export async function dirtyFingerprints(repo: string, paths: string[], deps: GateDeps): Promise<Record<string, string>> {
  const index = await deps.git(repo, ["ls-files", "--stage", "-z"]);
  if (index.code !== 0 || index.error) return {};
  const entries = new Map<string, string[]>();
  for (const row of index.out.split("\0")) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const rel = row.slice(tab + 1);
    entries.set(rel, [...(entries.get(rel) ?? []), row.slice(0, tab)]);
  }
  const result: Record<string, string> = Object.create(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
    while (next < paths.length) {
      const rel = paths[next++], file = path.join(repo, rel);
      if (path.isAbsolute(rel) || path.relative(repo, file).startsWith(".." + path.sep)) continue;
      try {
        const hash = createHash("sha256").update(JSON.stringify(entries.get(rel) ?? []));
        const before = await fs.lstat(file, { bigint: true }).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!before) { result[rel] = hash.update("deleted").digest("hex"); continue; }
        hash.update(String(before.mode));
        if (before.isSymbolicLink()) hash.update(await fs.readlink(file));
        else if (before.isFile()) for await (const chunk of createReadStream(file)) hash.update(chunk);
        else continue; // submodule/directory content is not proven by its inode
        const after = await fs.lstat(file, { bigint: true });
        if (before.ino === after.ino && before.size === after.size && before.ctimeNs === after.ctimeNs)
          result[rel] = hash.digest("hex");
      } catch { /* Evidence unavailable: retain the path as a candidate. */ }
    }
  }));
  return result;
}
