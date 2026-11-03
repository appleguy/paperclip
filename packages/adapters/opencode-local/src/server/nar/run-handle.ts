// Per-wake credential file for the Paperclip run bridge MCP. The shared OpenCode server cannot carry per-run env, so the
// model receives an opaque handle and the bridge resolves the run-scoped token from this 0600 file.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface RunHandleInput {
  configPath: string;
  apiUrl: string;
  apiKey: string;
  runId: string;
  agentId: string;
  companyId: string;
  ttlMs: number;
}

export const runHandleDir = (configPath: string) => path.join(path.dirname(configPath), "paperclip-run-handles");

export async function writeRunHandle(i: RunHandleInput): Promise<{ handle: string; cleanup: () => Promise<void> }> {
  const dir = runHandleDir(i.configPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = randomBytes(16).toString("hex");
  const file = path.join(dir, `${handle}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ apiUrl: i.apiUrl, apiKey: i.apiKey, runId: i.runId, agentId: i.agentId, companyId: i.companyId, expiresAt: new Date(Date.now() + i.ttlMs).toISOString() }),
    { mode: 0o600 },
  );
  return { handle, cleanup: () => fs.rm(file, { force: true }) };
}

export const runHandleNote = (handle: string) =>
  `Paperclip access: use the paperclip-run MCP tools (paperclipGetIssue, paperclipListComments, paperclipGetComment, paperclipGetHeartbeatContext, paperclipAddComment, paperclipUpdateIssue, ...) and pass handle "${handle}" on every call. Do not use curl or any API token. The handle is valid for this run only.`;
