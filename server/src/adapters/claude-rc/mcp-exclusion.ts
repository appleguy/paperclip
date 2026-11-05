/**
 * SCO-1033 (child of SCO-1021): managed claude_rc panes are persistent and carry no per-run PAPERCLIP_* env, so the
 * user-scope `paperclip` stdio MCP (env refs `${PAPERCLIP_*}`) fails every call. Per the owner decision on SCO-577 no
 * standing key is minted; instead the seat's cwd lists the server in projects[cwd].disabledMcpServers (documented
 * Claude Code per-project switch, verified on 2.1.311). The run-aware pcbridge channel and all other MCP servers are
 * untouched. Only that one array is edited; every other byte of ~/.claude.json is preserved.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");

const PAPERCLIP_ENV_REF = /\$\{PAPERCLIP_[A-Z_]+\}/;

/** User-scope stdio servers whose env is bound to per-run Paperclip variables. */
export function envBoundPaperclipServers(config: unknown): string[] {
  const servers = (config as { mcpServers?: Record<string, { env?: Record<string, unknown> }> } | null)?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers)
    .filter(([, s]) => Object.values(s?.env ?? {}).some(v => typeof v === "string" && PAPERCLIP_ENV_REF.test(v)))
    .map(([name]) => name);
}

/** Returns the new config text, or null when `cwd` already excludes every env-bound server (idempotent). */
export function withExclusion(text: string, cwd: string): string | null {
  const config = JSON.parse(text) as { projects?: Record<string, { disabledMcpServers?: unknown }> };
  const want = envBoundPaperclipServers(config);
  if (want.length === 0) return null;
  const project = (config.projects ??= {})[cwd] ??= {};
  const have = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers.filter((n): n is string => typeof n === "string") : [];
  const missing = want.filter(n => !have.includes(n));
  if (missing.length === 0) return null;
  project.disabledMcpServers = [...have, ...missing];
  return JSON.stringify(config, null, 2) + "\n";
}

export interface ExclusionResult { cwd: string; changed: boolean }

/**
 * Add the exclusion for one managed cwd. Claude Code rewrites ~/.claude.json itself, so the swap is compare-and-set:
 * re-read just before the rename and retry if another writer changed the file meanwhile. Never throws on a missing or
 * unparsable file (the seat must still start); returns changed=false then.
 */
export async function excludeEnvBoundMcp(cwd: string, file = CLAUDE_JSON, attempts = 5): Promise<ExclusionResult> {
  for (let i = 0; i < attempts; i++) {
    let before: string;
    let mode: number;
    try {
      [before, mode] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file).then(s => s.mode & 0o777)]);
    } catch { return { cwd, changed: false }; }
    let next: string | null;
    try { next = withExclusion(before, cwd); } catch { return { cwd, changed: false }; }
    if (next === null) return { cwd, changed: false };
    const tmp = `${file}.sco1033-${process.pid}-${i}`;
    await fs.writeFile(tmp, next, { mode });
    const again = await fs.readFile(file, "utf8").catch(() => null);
    if (again === before) {
      await fs.rename(tmp, file);
      return { cwd, changed: true };
    }
    await fs.rm(tmp, { force: true });
  }
  return { cwd, changed: false };
}
