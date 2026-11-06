import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, readRunEnv, type PaperclipMcpConfig } from "./config.js";
import { formatErrorResponse } from "./format.js";
import { createToolDefinitions } from "./tools.js";

export function createPaperclipMcpServer(config?: PaperclipMcpConfig) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config ?? { apiUrl: "", apiKey: "", companyId: null, agentId: null, runId: null });
  const templates = createToolDefinitions(client);
  const tools = config ? templates : templates.map(tool => ({ ...tool, execute: async (input: Record<string, unknown>) => {
    try {
      const env = await readRunEnv();
      const current = createToolDefinitions(new PaperclipApiClient(readConfigFromEnv(env)), env);
      return await current.find(candidate => candidate.name === tool.name)!.execute(input);
    } catch (error) { return formatErrorResponse(error); }
  } }));
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config?: PaperclipMcpConfig) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
