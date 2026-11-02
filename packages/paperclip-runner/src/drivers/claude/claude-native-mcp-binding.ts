import { startRunnerToolBridge, type RunnerToolCall } from "../runner-tool-bridge.js";

/** Identity supplied by the server's admitted run, not by a hook or the model. */
export type ClaudeNativeMcpScope = Readonly<{
  companyId: string;
  runId: string;
  taskId: string;
  leaseId: string;
  nativeSessionId: string;
}>;

/** The dispatcher must revalidate the live lease and persist its own operation receipts. */
export async function openClaudeNativeMcpBinding(input: {
  scope: ClaudeNativeMcpScope;
  tools: readonly Readonly<Record<string, unknown>>[];
  dispatch: (scope: ClaudeNativeMcpScope, call: RunnerToolCall) => Promise<unknown>;
}) {
  const scope = Object.freeze({ ...input.scope });
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid Claude native MCP scope");
  }
  // Check explicitly too: a JavaScript caller can omit a TypeScript-required property.
  for (const key of ["companyId", "runId", "taskId", "leaseId", "nativeSessionId"] as const) {
    if (typeof scope[key] !== "string" || !scope[key].trim()) throw new Error("Invalid Claude native MCP scope");
  }
  let closed = false;
  const bridge = await startRunnerToolBridge({
    tools: input.tools,
    preserveToolNames: true,
    preloadClaudeTaskTools: true,
    timeoutMs: null,
    handler: (call: RunnerToolCall) => {
      if (closed) throw new Error("Claude native MCP binding closed");
      return input.dispatch(scope, call);
    },
  });
  return Object.freeze({
    scope,
    /** Sensitive: write only to a private session config file, never logs or argv. */
    mcpConfig() {
      if (closed) throw new Error("Claude native MCP binding closed");
      return { mcpServers: { paperclip: { type: "http", url: bridge.url,
        headers: { Authorization: `Bearer ${bridge.secret}` } } } };
    },
    async close() {
      if (closed) return;
      closed = true;
      await bridge.close();
    },
  });
}
