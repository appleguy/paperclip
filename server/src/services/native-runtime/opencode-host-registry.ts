import type { Db } from "@paperclipai/db";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import type { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { readOpenCodeHost } from "./opencode-shared-recovery.js";
import { createOpenCodeNativePort } from "./opencode-native-port.js";

type Host = Awaited<ReturnType<typeof startOpenCodeSharedHost>>;
const hosts = new Map<string, { binding: OpenCodeSharedBinding; host: Host }>();
const bindingKeys = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort", "leaseOwner", "leaseAttempt", "controllerBootId", "controllerPid", "controllerGeneration"] as const;
function sameBinding(a: OpenCodeSharedBinding, b: OpenCodeSharedBinding) {
  return bindingKeys.every(key => a[key] === b[key]) && a.controllerProcessStartedAt.getTime() === b.controllerProcessStartedAt.getTime();
}

/** Retain the exact owned handle and its live proxy/MCP listeners in this process.
 * This is not proof that a listener survives a controller restart. */
export function retainOpenCodeManagedHost(binding: OpenCodeSharedBinding, host: Host) {
  if (host.generation !== binding.generation || hosts.has(binding.runId)) throw new Error("opencode_host_registry_conflict");
  hosts.set(binding.runId, { host, binding: Object.freeze({ ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) }) });
}

/** Reconnect only the same run/controller epoch and a currently held DB lease.
 * No native session creation, prompt, semantic replay, or listener rebinding. */
export async function reconnectOpenCodeManagedHost(db: Db, binding: OpenCodeSharedBinding) {
  const retained = hosts.get(binding.runId);
  if (!retained || !sameBinding(retained.binding, binding)) throw new Error("opencode_host_registry_binding_mismatch");
  await readOpenCodeHost(db, binding);
  await retained.host.verifySession(binding.providerSessionId, binding);
  await retained.host.verifyCatalog(binding.model, binding.effort);
  await readOpenCodeHost(db, binding);
  return { host: retained.host, binding: retained.binding, admitted: createOpenCodeNativePort(db, retained.binding, retained.host) };
}

/** Called only after exact owned-child shutdown has completed. */
export function forgetOpenCodeManagedHost(binding: OpenCodeSharedBinding, host: Host) {
  const current = hosts.get(binding.runId);
  if (!current || current.host !== host || !sameBinding(current.binding, binding)) throw new Error("opencode_host_registry_binding_mismatch");
  hosts.delete(binding.runId);
}
