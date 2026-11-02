import { describe, expect, it, vi } from "vitest";
import { openClaudeNativeMcpBinding } from "./claude-native-mcp-binding.js";

const scope = { companyId: "company", runId: "run", taskId: "task", leaseId: "lease", nativeSessionId: "session" };

describe("Claude native scoped MCP binding", () => {
  it("serves real MCP initialize, listing and idempotent calls through the admitted scope", async () => {
    const dispatch = vi.fn(async (bound, call) => ({ accepted: true, receiptId: `${bound.runId}:${call.callId}` }));
    const binding = await openClaudeNativeMcpBinding({ scope, tools: [{ name: "task_read", inputSchema: { type: "object" } }], dispatch });
    const config = binding.mcpConfig().mcpServers.paperclip;
    const rpc = (body: object, authorization = config.headers.Authorization) => fetch(config.url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    try {
      expect((await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })).status).toBe(200);
      expect((await rpc({ id: 2, method: "tools/list" }, "Bearer wrong")).status).toBe(401);
      const list = await (await rpc({ id: 3, method: "tools/list" })).json() as any;
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain("paperclip_finish");
      const request = { id: "call-1", method: "tools/call", params: { name: "task_read", arguments: {} } };
      expect((await (await rpc(request)).json() as any).result.isError).not.toBe(true);
      await rpc(request);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![0]).toEqual(scope);
      expect(Object.isFrozen(dispatch.mock.calls[0]![0])).toBe(true);
      const conflict = await (await rpc({ ...request, params: { name: "task_read", arguments: { changed: true } } })).json() as any;
      expect(conflict.result.isError).toBe(true);
    } finally { await binding.close(); }
    expect(() => binding.mcpConfig()).toThrow();
  });
  it("rejects missing scope before opening a listener", async () => {
    await expect(openClaudeNativeMcpBinding({ scope: { ...scope, leaseId: "" }, tools: [], dispatch: async () => ({}) })).rejects.toThrow("Invalid Claude native MCP scope");
  });
});
