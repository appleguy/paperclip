// Run-handle MCP bridge for shared agent servers (OpenCode NAR). A shared server cannot carry per-run env, so the
// adapter writes a 0600 credential file per wake and the model passes only an opaque `handle`. The bridge reads the
// run-scoped bearer token from that file on every call; the token (and the owner's board token) never enter the
// model context, and writes carry the agent's own identity and run id.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { normalizeApiUrl } from "./config.js";
import { formatErrorResponse } from "./format.js";
import { createToolDefinitions } from "./tools.js";

export const RUN_BRIDGE_TOOLS = [
  "paperclipGetIssue",
  "paperclipListComments",
  "paperclipGetComment",
  "paperclipGetHeartbeatContext",
  "paperclipListIssues",
  "paperclipListDocuments",
  "paperclipGetDocument",
  "paperclipAddComment",
  "paperclipUpdateIssue",
] as const;

const HANDLE_RE = /^[a-f0-9]{32}$/;

export interface RunHandleCredentials {
  apiUrl: string;
  apiKey: string;
  runId: string;
  agentId: string;
  companyId: string;
  expiresAt: string;
}

export async function readRunHandle(dir: string, handle: string, now = Date.now()): Promise<RunHandleCredentials> {
  if (!HANDLE_RE.test(handle)) throw new Error("invalid Paperclip run handle");
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, `${handle}.json`), "utf8");
  } catch {
    throw new Error("Paperclip run handle is unknown or has ended; use the handle from the latest wake prompt");
  }
  const c = JSON.parse(raw) as Partial<RunHandleCredentials>;
  if (!c.apiUrl || !c.apiKey || !c.runId || !c.agentId || !c.companyId || !c.expiresAt) throw new Error("run handle file is incomplete");
  if (Date.parse(c.expiresAt) <= now) throw new Error("Paperclip run handle expired; use the handle from the latest wake prompt");
  return c as RunHandleCredentials;
}

export function createRunBridgeServer(handleDir: string) {
  if (!path.isAbsolute(handleDir)) throw new Error("PAPERCLIP_BRIDGE_HANDLE_DIR must be absolute");
  const store = new AsyncLocalStorage<PaperclipApiClient>();
  const scoped = new Proxy({} as PaperclipApiClient, {
    get(_t, prop) {
      const c = store.getStore();
      if (!c) throw new Error("no run handle in scope");
      const v = (c as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? v.bind(c) : v;
    },
  });
  const server = new McpServer({ name: "paperclip-run", version: "0.1.0" });
  const defs = createToolDefinitions(scoped).filter((t) => (RUN_BRIDGE_TOOLS as readonly string[]).includes(t.name));
  for (const tool of defs) {
    const shape = { ...tool.schema.shape, handle: z.string().describe("Paperclip run handle from the wake prompt") };
    server.tool(tool.name, tool.description, shape, async (input: Record<string, unknown>) => {
      try {
        const { handle, ...rest } = input as { handle: string } & Record<string, unknown>;
        const c = await readRunHandle(handleDir, handle);
        const client = new PaperclipApiClient({
          apiUrl: normalizeApiUrl(c.apiUrl), apiKey: c.apiKey, companyId: c.companyId, agentId: c.agentId, runId: c.runId,
        });
        return await store.run(client, () => tool.execute(rest));
      } catch (error) {
        return formatErrorResponse(error);
      }
    });
  }
  return { server, toolNames: defs.map((t) => t.name) };
}

export async function runRunBridge(handleDir = process.env.PAPERCLIP_BRIDGE_HANDLE_DIR ?? "") {
  const { server } = createRunBridgeServer(handleDir);
  await server.connect(new StdioServerTransport());
}
