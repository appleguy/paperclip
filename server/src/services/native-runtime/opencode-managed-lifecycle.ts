import type { Db } from "@paperclipai/db";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import type { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { reconnectOpenCodeManagedHost } from "./opencode-host-registry.js";
import { restoreOpenCodePrivateListeners } from "./opencode-proxy-restoration.js";
import { loadOpenCodeSuccessorBinding } from "./opencode-managed-admission.js";
import type { NativeExecutionInputV12 } from "../../vendor/paperclip-runner/index.js";

type OwnedHost = Awaited<ReturnType<typeof startOpenCodeSharedHost>>;
type Prompt = { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean };

/** Controller-only lifecycle. The exact native session must have been verified
 * by this owned host, and the run must already hold its finalization lease. */
export async function startOpenCodeManagedOperation(input: { db: Db; host: OwnedHost; binding: OpenCodeSharedBinding; prompt: Prompt }) {
  await input.host.persistForRun(input.db, input.binding);
  return input.host.dispatchForRun(input.db, input.binding, input.prompt);
}

/** Reconnect only a same-controller live host with its original proxy and MCP.
 * A process recovered without those listeners is observation-only. */
export async function resumeOpenCodeManagedOperation(input: { db: Db; binding: OpenCodeSharedBinding; prompt: Prompt }) {
  const { host } = await reconnectOpenCodeManagedHost(input.db, input.binding);
  return host.dispatchForRun(input.db, input.binding, input.prompt);
}

/** A successor may restore only observation-capable listeners. No prompt or
 * tool admission follows from recovering a native process. */
export async function restoreOpenCodeManagedObservation(input: { db: Db; execution: NativeExecutionInputV12; runnerInstanceId: string; leaseOwner: string; attempt: number; controller: { bootId: string; pid: number; processStartedAt: Date }; environment: NodeJS.ProcessEnv; tools: readonly Readonly<Record<string, unknown>>[] }) {
  const binding = await loadOpenCodeSuccessorBinding(input.db, input);
  return restoreOpenCodePrivateListeners(input.db, binding, input.environment, input.tools);
}
