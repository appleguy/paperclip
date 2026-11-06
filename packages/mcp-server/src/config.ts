import { readFile } from "node:fs/promises";

export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 && !/^\$\{PAPERCLIP_[A-Z0-9_]+\}$/.test(value.trim()) ? value.trim() : null;
}

export async function readRunEnv(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const file = nonEmpty(env.PAPERCLIP_RC_RUN_ENV);
  if (!file) return env;
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env;
    throw new Error("Unable to read the Paperclip seat run environment");
  }
  const merged = { ...env };
  for (const line of text.split("\n")) {
    const match = /^export (PAPERCLIP_[A-Z0-9_]+)=('(?:[^']|'\\'')*')$/.exec(line);
    if (match && !nonEmpty(merged[match[1]!])) merged[match[1]!] = match[2]!.slice(1, -1).replace(/'\\''/g, "'");
  }
  return merged;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("no active Paperclip run for this seat (missing PAPERCLIP_API_URL)");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("no active Paperclip run for this seat (missing PAPERCLIP_API_KEY)");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}
