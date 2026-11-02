import { resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, normalize } from "node:path";

export interface ClaudeNativeHostSettings {
  claudeExecutable: string;
  home: string;
  claudeConfigDir?: string;
}

/** Resolve host-owned settings only. No request, session selector, command,
 * credentials or client-supplied environment is accepted by this boundary. */
export async function resolveClaudeNativeHostSettings(): Promise<ClaudeNativeHostSettings> {
  const home = homedir();
  const config = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!isAbsolute(home) || home.includes("\0") ||
      (config && (!isAbsolute(config) || config.includes("\0")))) {
    throw new Error("Invalid Claude host configuration");
  }
  // Ignore relative/empty PATH entries: they can otherwise resolve against a
  // working directory instead of the server's configured executable search.
  const path = (process.env.PATH ?? process.env.Path ?? "").split(delimiter)
    .filter((entry) => entry && !entry.includes("\0") && isAbsolute(entry)).join(delimiter);
  const executable = await resolveCommandForLogs("claude", home, { PATH: path });
  if (!isAbsolute(executable)) throw new Error("Native Claude CLI is unavailable on this Paperclip host");
  try {
    const target = await realpath(executable);
    if (!isAbsolute(target) || !(await stat(target)).isFile()) throw new Error();
    await access(target, constants.X_OK);
  } catch {
    throw new Error("Native Claude CLI is unavailable on this Paperclip host");
  }
  return { claudeExecutable: normalize(executable), home: normalize(home),
    ...(config ? { claudeConfigDir: normalize(config) } : {}) };
}
