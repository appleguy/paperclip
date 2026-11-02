import { createDb } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { currentNativeControllerIdentity, claimNativeRestartRecoveries } from "./native-restart-recovery.js";
import { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { startOpenCodeProviderProxy } from "../../vendor/paperclip-runner/index.js";
import { restoreClaimedOpenCodeObservation } from "./opencode-restart-claim.js";
import { loadOpenCodeSuccessorBinding } from "./opencode-managed-admission.js";
import { readOpenCodeHost, readOpenCodeHostRestoration } from "./opencode-shared-recovery.js";
import { createOpenCodeBoundFetch } from "./opencode-bound-fetch.js";
import { createOpenCodeSemanticHandler } from "./opencode-semantic-handler.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

// Fixture IPC remains private; no credential is sent back to the parent.
process.once("message", async (input: any) => {
  const db = createDb(input.connectionString);
  let host: Awaited<ReturnType<typeof startOpenCodeSharedHost>> | undefined;
  try {
    const controller = await currentNativeControllerIdentity();
    if (input.mode === "original") {
      const proxy = await startOpenCodeProviderProxy(input.providerBase, "fixture-key", "fixture-model", {});
      host = await startOpenCodeSharedHost({ executable: "/opt/homebrew/bin/opencode", dataRoot: input.root, workspaceCwd: input.root,
        provider: { provider: "paperclip", model: "fixture-model", baseURL: proxy.baseURL, token: proxy.token }, onShutdown: proxy.close,
        mcp: { tools: [{ name: "get_task_context", inputSchema: { type: "object" } }], createHandler: () => async () => { throw new Error("fixture_denied"); } } });
      process.send?.({ stage: "ready", controller, generation: host.generation, proxyPort: Number(new URL(proxy.baseURL).port) });
      const binding: any = await new Promise(resolve => process.once("message", resolve));
      const fullBinding = { ...binding, generation: host.generation, epoch: input.epoch, version: "2.2.5" as const, providerSessionId: input.providerSessionId, leaseOwner: input.leaseOwner, leaseAttempt: 1, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt, controllerGeneration: 1 };
      await host.createManagedSession(db, fullBinding);
      let returnedActiveEmpty: boolean | undefined;
      if (input.returnedHistory) {
        const authority = new PaperclipRunnerToolAuthority(db, { ...fullBinding, dotRuntime: true, workspaceBridge: true, workspaceRoot: input.root });
        const handler = createOpenCodeSemanticHandler(db, fullBinding, { execute: call => authority.execute(call), completionFeedback: async () => { throw new Error("unexpected_terminal"); }, completionContract: { revision: "fixture", criterionIds: [] } });
        await handler({ tool: "workspace_write", callId: "fixture-write", arguments: { path: "fixture.txt", text: "owned fixture", expectedSha256: null }, signal: new AbortController().signal });
        const saved = await readOpenCodeHost(db, fullBinding);
        const nativeFetch = createOpenCodeBoundFetch({ pid: saved.host.pid, port: saved.host.port, isAlive: () => { try { process.kill(saved.host.pid, 0); return true; } catch { return false; } } });
        const response = await nativeFetch(`http://127.0.0.1:${saved.host.port}/api/session/active`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${saved.password}`).toString("base64")}` }, signal: AbortSignal.timeout(5000) });
        const value = await response.json() as { data?: unknown };
        returnedActiveEmpty = response.ok && !!value.data && typeof value.data === "object" && !Array.isArray(value.data) && Object.keys(value.data).length === 0;
      }
      process.send?.({ stage: "created", returnedActiveEmpty });
      await new Promise(resolve => process.once("message", resolve));
      // Simulate controller loss without calling host.shutdown or proxy.close.
      process.exit(0);
    }
    const [claim] = await claimNativeRestartRecoveries({ db, runIds: [input.runId], restartKind: "hard" });
    if (claim?.kind !== "observe_saved_opencode_host") throw new Error(`claim_${claim?.kind ?? "missing"}`);
    const binding = await loadOpenCodeSuccessorBinding(db, { execution: input.execution, runnerInstanceId: input.runnerInstanceId, leaseOwner: claim.leaseOwner, attempt: claim.providerAttempt, controller });
    let oldLeaseDenied = false;
    try { await readOpenCodeHostRestoration(db, { ...binding, leaseOwner: "original", controllerGeneration: 1 }); }
    catch (error) { oldLeaseDenied = error instanceof Error && error.message === "opencode_recovery_lease_lost"; }
    if (!oldLeaseDenied) throw new Error("old_lease_not_denied");
    const saved = await readOpenCodeHostRestoration(db, binding);
    const nativeFetch = createOpenCodeBoundFetch({ pid: saved.host.pid, port: saved.host.port, isAlive: () => { try { process.kill(saved.host.pid, 0); return true; } catch { return false; } } });
    const activeResponse = await nativeFetch(`http://127.0.0.1:${saved.host.port}/api/session/active`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${saved.password}`).toString("base64")}` }, signal: AbortSignal.timeout(5000) });
    const activeJson = await activeResponse.json() as { data?: unknown };
    const activeShape = { status: activeResponse.status, rootArray: Array.isArray(activeJson), dataArray: Array.isArray(activeJson.data), rootKeys: Object.keys(activeJson).sort(), dataType: typeof activeJson.data, dataKeys: activeJson.data && typeof activeJson.data === "object" ? Object.keys(activeJson.data).sort() : [] };
    const params = { db, claim, execution: input.execution, runnerInstanceId: input.runnerInstanceId, environment: { PAPERCLIP_AI_PROVIDER_URL: input.providerBase, PAPERCLIP_AI_PROVIDER_KEY: "fixture-key" }, tools: [{ name: "get_task_context", inputSchema: { type: "object" } }] };
    let changedEpochDenied = false;
    try { await restoreClaimedOpenCodeObservation({ ...params, claim: { ...claim, savedHost: { ...claim.savedHost, epoch: "foreign" } } }); }
    catch (error) { changedEpochDenied = error instanceof Error && error.message === "opencode_restart_claim_mismatch"; }
    if (!changedEpochDenied) throw new Error("foreign_epoch_not_denied");
    let portTakeoverDenied = false;
    try { await restoreClaimedOpenCodeObservation(params); }
    catch (error) { portTakeoverDenied = (error as NodeJS.ErrnoException).code === "EADDRINUSE"; }
    if (!portTakeoverDenied) throw new Error("foreign_listener_not_denied");
    process.send?.({ stage: "port-held" });
    await new Promise(resolve => process.once("message", resolve));
    const restored = await restoreClaimedOpenCodeObservation(params);
    try {
      const denied = await fetch(`${saved.proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${saved.proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-model" }), signal: AbortSignal.timeout(5000) });
      const toolDenied = await restored.verifyToolDenial("get_task_context");
      process.send?.({ stage: "restored", controller, claim, hostPid: saved.host.pid, proxyPort: Number(new URL(saved.proxy.baseURL).port), sessionId: binding.providerSessionId, generation: binding.generation, epoch: binding.epoch, denied: denied.status, toolDenied, changedEpochDenied, portTakeoverDenied, oldLeaseDenied, activeShape });
      await new Promise(resolve => process.once("message", resolve));
    } finally { await restored.close(); }
  } catch (error) {
    process.send?.({ stage: "error", error: error instanceof Error ? error.message : "unknown" });
    if (host) await host.shutdown().catch(() => {});
  } finally {
    await db.$client.end({ timeout: 1 }).catch(() => {});
    process.disconnect?.();
  }
});
