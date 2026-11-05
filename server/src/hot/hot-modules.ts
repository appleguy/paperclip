// SCO-818: hot-reloadable leaf modules. A hot deploy installs the new payload,
// then writes <PAPERCLIP_HOME>/hot/active.json. Calls made after that go to the
// new payload's copy of the module; calls already running finish on the code
// they started with, so no run is interrupted and the server is not restarted.
// Only modules listed in hot-paths.txt may use this (no shared singletons).
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../middleware/logger.js";
import { readBuildCommit } from "../build-commit.js";
import { resolvePaperclipHomeDir } from "../home-paths.js";

export interface HotMarker {
  schema: 1;
  /** Commit of the server process this marker is valid for. */
  baseSha: string;
  /** Commit whose copy of the hot modules should serve new calls. */
  hotSha: string;
  /** dist directory of the payload holding the hot modules. */
  distRoot: string;
}

const hotDir = () => path.join(resolvePaperclipHomeDir(), "hot");
const markerPath = () => path.join(hotDir(), "active.json");
const ackPath = () => path.join(hotDir(), "loaded.json");

// Identity of the running build: its commit stamp, else the 12-char payload
// directory name (cli/installs/<source>/<short sha>/...) this module loaded from.
const processSha: string | null =
  readBuildCommit() ?? /\/installs\/[^/]+\/([0-9a-f]{12})\//.exec(import.meta.url)?.[1] ?? null;
let cachedMtime = -1;
let cachedMarker: HotMarker | null = null;
const loaded = new Map<string, Promise<unknown>>();

function readMarker(): HotMarker | null {
  let mtime: number;
  try { mtime = statSync(markerPath()).mtimeMs; } catch { cachedMtime = -1; cachedMarker = null; return null; }
  if (mtime === cachedMtime) return cachedMarker;
  cachedMtime = mtime;
  try {
    const m = JSON.parse(readFileSync(markerPath(), "utf8")) as HotMarker;
    // A marker written for another process build is stale (e.g. after a restart).
    cachedMarker = m?.schema === 1 && typeof m.hotSha === "string" && typeof m.distRoot === "string" &&
      processSha && m.baseSha.startsWith(processSha.slice(0, 12)) ? m : null;
  } catch { cachedMarker = null; }
  return cachedMarker;
}

/** Import `rel` (dist-relative, e.g. "adapters/claude-rc/execute.js") from the
 * hot payload when one is active, otherwise from the running build. */
export async function hotImport<T>(rel: string, builtin: () => Promise<T>): Promise<T> {
  const marker = readMarker();
  if (!marker) return builtin();
  const key = `${marker.hotSha}:${rel}`;
  let p = loaded.get(key) as Promise<T> | undefined;
  if (!p) {
    const url = `${pathToFileURL(path.join(marker.distRoot, rel)).href}?hot=${marker.hotSha}`;
    p = import(url) as Promise<T>;
    p.then(
      () => logger.info({ rel, hotSha: marker.hotSha }, "hot module loaded"),
      (err) => { loaded.delete(key); logger.error({ err, rel }, "hot module load failed; using built-in"); },
    );
    loaded.set(key, p);
  }
  try { return await p; } catch { return builtin(); }
}

/** Preload `rels` for the active marker and write the ack pc-deploy waits for. */
export async function activateHot(rels: string[]): Promise<void> {
  const marker = readMarker();
  if (!marker) return;
  for (const rel of rels) await hotImport(rel, async () => { throw new Error("no builtin"); });
  mkdirSync(hotDir(), { recursive: true });
  const tmp = `${ackPath()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ hotSha: marker.hotSha, pid: process.pid, loadedAt: new Date().toISOString() }));
  renameSync(tmp, ackPath());
}

/** Poll the marker so a hot deploy is acknowledged without waiting for the next run. */
export function startHotWatcher(rels: string[], intervalMs = 2000): () => void {
  let last = "";
  const timer = setInterval(() => {
    const m = readMarker();
    if (!m || m.hotSha === last) return;
    last = m.hotSha;
    activateHot(rels).catch((err) => logger.error({ err }, "hot activation failed"));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
