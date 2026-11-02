import { agentTaskSessions, type Db, type heartbeatRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProcessStartedAt } from "../hot-restart.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import type { NativeExecutionInputV12 } from "../../vendor/paperclip-runner/index.js";

const execute = promisify(execFile);
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Called under the existing issue/run/coordinator transaction locks. This is
 * evidence for observation only; it never releases credentials or sends work. */
export async function inspectOpenCodeRestartClaim(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string, projectId: string | null): Promise<{ kind: "other" } | { kind: "hold"; reason: string } | { kind: "saved"; taskSessionId: string; generation: string; epoch: string }> {
  const execution = object(object(run.runnerProfileJson)?.nativeExecutionInput);
  const provider = object(execution?.provider), sessionInput = object(execution?.session), binding = object(execution?.binding);
  const rows = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, run.companyId), eq(agentTaskSessions.agentId, run.agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, issueId), eq(agentTaskSessions.lastRunId, run.id))).for("update");
  const marked = rows.filter(row => Object.prototype.hasOwnProperty.call(object(row.sessionParamsJson) ?? {}, "opencodeSharedV2"));
  if (provider?.kind !== "opencode_shared_v2" && marked.length === 0) return { kind: "other" };
  const hold = { kind: "hold", reason: "opencode_saved_host_unqualified" } as const;
  if (provider?.kind !== "opencode_shared_v2" || provider.cliVersion !== "2.2.5" || sessionInput?.driverKind !== "opencode_shared_v2" || rows.length !== 1 || marked.length !== 1 || !projectId || !run.nativeSessionId || !run.runnerInstanceId) return hold;
  const row = marked[0]!, saved = object(object(row.sessionParamsJson)?.opencodeSharedV2), host = object(saved?.host), creation = object(saved?.sessionCreation);
  const expected: Record<string, unknown> = { companyId: run.companyId, projectId, issueId, agentId: run.agentId, runId: run.id, taskSessionId: row.id, normalizedSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId, version: "2.2.5", model: provider.model, effort: provider.effort };
  if (!saved || !host || Object.entries(expected).some(([key, value]) => typeof value !== "string" || !value || saved[key] !== value) || binding?.companyId !== run.companyId || binding?.issueId !== issueId || binding?.agentId !== run.agentId || binding?.runId !== run.id || sessionInput.normalizedSessionId !== run.nativeSessionId || typeof saved.providerSessionId !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(saved.providerSessionId) || typeof saved.generation !== "string" || !saved.generation || typeof saved.epoch !== "string" || !saved.epoch || host.generation !== saved.generation || !creation || creation.state !== "observed" || creation.sessionId !== saved.providerSessionId || creation.model !== saved.model || creation.effort !== saved.effort || creation.workingDirectory !== host.workingDirectory) return hold;
  if (!(saved.cursor === null || (Number.isSafeInteger(saved.cursor) && Number(saved.cursor) >= 0))) return hold;
  if ((saved.mutations !== undefined && (!Array.isArray(saved.mutations) || saved.mutations.length !== 0)) || (saved.semanticCalls !== undefined && (!Array.isArray(saved.semanticCalls) || saved.semanticCalls.length !== 0)) || saved.mcpRestoration !== undefined) return { kind: "hold", reason: "opencode_restart_outcome_unknown" };
  if (!Number.isSafeInteger(host.pid) || Number(host.pid) < 1 || !Number.isSafeInteger(host.port) || Number(host.port) < 1 || Number(host.port) > 65535 || typeof host.startedAt !== "string" || typeof host.executable !== "string" || !host.executable.startsWith("/") || typeof host.namespace !== "string" || !host.namespace.startsWith("/") || typeof host.workingDirectory !== "string" || !host.workingDirectory.startsWith("/") || typeof host.secretId !== "string" || !host.secretId || !Number.isSafeInteger(host.secretVersion) || Number(host.secretVersion) < 1) return hold;
  try {
    const pid = Number(host.pid), before = await readProcessStartedAt(pid);
    const [command, cwd, listener] = await Promise.all([
      execute("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000, maxBuffer: 4096 }),
      execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 3000, maxBuffer: 4096 }),
      execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${host.port}`, "-sTCP:LISTEN", "-Fn"], { timeout: 3000, maxBuffer: 4096 }),
    ]);
    if (process.platform !== "darwin" || before !== host.startedAt || await readProcessStartedAt(pid) !== before || command.stdout.trim() !== host.executable || !cwd.stdout.split("\n").includes(`n${host.workingDirectory}`) || !listener.stdout.split("\n").some(line => line === `n127.0.0.1:${host.port}`)) return hold;
  } catch { return hold; }
  return { kind: "saved", taskSessionId: row.id, generation: saved.generation, epoch: saved.epoch };
}

/** Bind the observation claim back to the live lease and immutable saved epoch
 * before creating deny-only listeners. This does not authorize native writes. */
export async function restoreClaimedOpenCodeObservation(input: { db: Db; claim: Extract<NativeRestartRecoveryClaim, { kind: "observe_saved_opencode_host" }>; execution: NativeExecutionInputV12; runnerInstanceId: string; environment: NodeJS.ProcessEnv; tools: readonly Readonly<Record<string, unknown>>[] }) {
  const { currentNativeControllerIdentity } = await import("./native-restart-recovery.js");
  const { loadOpenCodeSuccessorBinding } = await import("./opencode-managed-admission.js");
  const { restoreOpenCodePrivateListeners } = await import("./opencode-proxy-restoration.js");
  const controller = await currentNativeControllerIdentity();
  if (input.execution.binding.runId !== input.claim.runId) throw new Error("opencode_restart_claim_mismatch");
  const binding = await loadOpenCodeSuccessorBinding(input.db, { execution: input.execution, runnerInstanceId: input.runnerInstanceId, leaseOwner: input.claim.leaseOwner, attempt: input.claim.providerAttempt, controller });
  if (binding.controllerGeneration !== input.claim.controllerGeneration || binding.taskSessionId !== input.claim.savedHost.taskSessionId || binding.generation !== input.claim.savedHost.generation || binding.epoch !== input.claim.savedHost.epoch) throw new Error("opencode_restart_claim_mismatch");
  return restoreOpenCodePrivateListeners(input.db, binding, input.environment, input.tools);
}
