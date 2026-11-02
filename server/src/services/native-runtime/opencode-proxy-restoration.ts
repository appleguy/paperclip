import type { Db } from "@paperclipai/db";
import { startOpenCodeMcpBridge, startOpenCodeProviderProxy } from "../../vendor/paperclip-runner/index.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { readOpenCodeHostRestoration } from "./opencode-shared-recovery.js";
import { recoverOpenCodeSharedHost } from "./opencode-shared-host.js";
import { resolveOpenCodeSharedProvider } from "./opencode-provider-profile.js";

/** Restore the original private listener only after current lease, journal,
 * native process/session and provider settings are attested. This does not
 * admit prompts or restore MCP and is not a complete controller recovery. */
export async function restoreOpenCodeProviderListener(db: Db, binding: OpenCodeSharedBinding, environment: NodeJS.ProcessEnv) {
  const saved = await readOpenCodeHostRestoration(db, binding);
  const profile = await resolveOpenCodeSharedProvider({ model: binding.model, environment });
  const native = await recoverOpenCodeSharedHost(db, binding);
  await native.verifySessionAndCatalog(saved.proxy);
  const proxyUrl = new URL(saved.proxy.baseURL);
  const proxy = await startOpenCodeProviderProxy(profile.baseUrl, profile.key, profile.model, environment, { port: Number(proxyUrl.port), token: saved.proxy.token });
  try {
    const current = await readOpenCodeHostRestoration(db, binding);
    if (current.host.generation !== saved.host.generation || current.host.pid !== saved.host.pid || current.host.startedAt !== saved.host.startedAt || current.proxy.baseURL !== saved.proxy.baseURL || current.proxy.token !== saved.proxy.token) throw new Error("opencode_proxy_restoration_binding_changed");
    await native.verifySessionAndCatalog(saved.proxy);
    return { native, close: proxy.close };
  } catch (error) { await proxy.close(); throw error; }
}

/** Reattach a fresh private MCP endpoint without granting tool execution.
 * Provider requests and tools stay denied until a separate admitted controller
 * proves quiescence and installs a write-capable grant. */
export async function restoreOpenCodePrivateListeners(db: Db, binding: OpenCodeSharedBinding, environment: NodeJS.ProcessEnv, tools: readonly Readonly<Record<string, unknown>>[]) {
  const restored = await restoreOpenCodeProviderListener(db, binding, environment);
  let bridge: Awaited<ReturnType<typeof startOpenCodeMcpBridge>> | undefined;
  let toolHandlerInvoked = false;
  try {
    bridge = await startOpenCodeMcpBridge({ tools, admitSharedCall: async () => { throw new Error("opencode_recovery_tool_not_admitted"); }, handler: async () => { toolHandlerInvoked = true; throw new Error("opencode_recovery_tool_not_admitted"); } });
    await restored.native.replaceMcp(bridge);
    const retained = bridge;
    return {
      native: restored.native,
      // A bounded, local health probe exercises the actual deny-only bridge;
      // it does not return the bridge credential or invoke a tool handler.
      async verifyToolDenial(tool: string) {
        const response = await fetch(retained.url, { method: "POST", headers: { authorization: `Bearer ${retained.secret}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "recovery-denial-check", method: "tools/call", params: { name: tool, arguments: {}, _meta: { "ai.opencode/sessionID": binding.providerSessionId } } }), signal: AbortSignal.timeout(3000) });
        const body = await response.json() as { result?: { isError?: unknown } };
        return response.ok && body.result?.isError === true && !toolHandlerInvoked;
      },
      close: async () => { await retained.close(); await restored.close(); },
    };
  } catch (error) { await bridge?.close(); await restored.close(); throw error; }
}
