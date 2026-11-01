import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { conflict, HttpError, unprocessable } from "../../errors.js";
import { createClaudeNativeAuthority, type ClaudeNativeCompletion, type ClaudeNativeTaskTools } from "./claude-native-authority.js";
import { currentNativeControllerIdentity, type NativeControllerIdentity } from "./native-restart-recovery.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

/**
 * `heartbeat_runs.driver_kind` the executor must record when it admits a run for the
 * genuine Claude interactive session. No executor path writes it yet, so by default
 * nothing qualifies; this never launches Claude on another provider's session id.
 */
export const CLAUDE_INTERACTIVE_DRIVER_KIND = "claude_interactive_v1";

const DEFAULT_REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set(["get_task_context", "set_task_title"]);
const DEFAULT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["get_task_context"]);
const UNAVAILABLE = "Claude admitted-run authority unavailable";

export interface ClaudeNativeAdmissionOptions {
  /** Server controller identity; defaults to this process. Must equal the finalization row's claimant. */
  controller?: () => Promise<NativeControllerIdentity>;
  /** Cheap synchronous check that this server still owns the run's executor. */
  assertControllerActive?: () => void;
  /** Task tool factory; defaults to the real PaperclipRunnerToolAuthority (durable receipts). */
  tools?: (binding: { companyId: string; issueId: string; runId: string; agentId: string; nativeSessionId: string })
    => ClaudeNativeTaskTools & { close?(): void };
  /** Completion boundary for paperclip_finish / paperclip_block; absent: those tools are not offered. */
  completion?: (binding: { companyId: string; issueId: string; runId: string }) => ClaudeNativeCompletion | undefined;
  /** Tools safe to repeat after an unknown outcome. Default: only pure reads and the idempotency-keyed
   * durable-receipt title write of the real task tools; everything else stays unknown, never replayed. */
  replaySafeTools?: ReadonlySet<string>;
  /** Tools still allowed after finish/block intent. Default: pure reads only. */
  readOnlyTools?: ReadonlySet<string>;
  driverKind?: string;
}

/**
 * Builds `ClaudeManagedOptions.admitRun`. It reads only rows the existing admission
 * machinery already wrote (run, native session, active lease, claimed finalization);
 * it never creates or rebinds a run, session, lease or writer generation.
 */
export function createClaudeNativeAdmission(db: Db, options: ClaudeNativeAdmissionOptions = {}) {
  const driverKind = options.driverKind ?? CLAUDE_INTERACTIVE_DRIVER_KIND;
  const active = new Set<string>();
  return async function admitRun(input: { companyId: string; actorId: string; runId: string }) {
    const key = `${input.companyId}:${input.runId}`;
    // One live Claude session per admitted run in this server process.
    if (active.has(key)) throw conflict("Claude session already active for this run");
    active.add(key);
    let tools: (ClaudeNativeTaskTools & { close?(): void }) | undefined;
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      active.delete(key);
      try { tools?.close?.(); } catch { /* closing must not mask the lifecycle result */ }
    };
    try {
      const [run] = await db.select({
        agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
        driverKind: heartbeatRuns.driverKind, runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
      }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
      if (!run || run.runtimeMode !== "native" || run.status !== "running" || !run.issueId || !run.nativeSessionId) throw conflict(UNAVAILABLE);
      if (run.driverKind !== driverKind) throw unprocessable("Run is not admitted for the Claude interactive driver");
      const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases)
        .where(and(eq(environmentLeases.heartbeatRunId, input.runId), eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.status, "active")))
        .limit(2);
      const [claim] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner, attempt: nativeRunFinalizations.attempt })
        .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId))).limit(1);
      if (leases.length !== 1 || !claim?.leaseOwner || !(claim.attempt >= 1)) throw conflict(UNAVAILABLE);
      const binding = { companyId: input.companyId, issueId: run.issueId, runId: input.runId, agentId: run.agentId, nativeSessionId: run.nativeSessionId };
      tools = options.tools?.(binding) ?? new PaperclipRunnerToolAuthority(db, { ...binding, normalizedSessionId: binding.nativeSessionId });
      const authority = await createClaudeNativeAuthority(db, {
        scope: { companyId: input.companyId, runId: input.runId, taskId: run.issueId, leaseId: leases[0]!.id, nativeSessionId: run.nativeSessionId },
        controller: { leaseOwner: claim.leaseOwner, attempt: claim.attempt, identity: await (options.controller ?? currentNativeControllerIdentity)() },
        assertControllerActive: options.assertControllerActive ?? (() => {}),
        tools,
        completion: options.completion?.(binding),
        replaySafeTools: options.replaySafeTools ?? DEFAULT_REPLAY_SAFE_TOOLS,
        readOnlyTools: options.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS,
      });
      return {
        scope: { companyId: input.companyId, runId: input.runId, taskId: run.issueId, leaseId: leases[0]!.id, nativeSessionId: run.nativeSessionId },
        definitions: authority.definitions,
        dispatch: authority.dispatch,
        settled: authority.settled,
        unsettled: authority.unsettled,
        binding: authority.binding,
        async close() { release(); },
      };
    } catch (error) {
      release();
      // Authority refusals are expected conflicts; never reflect their detail to the caller.
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && error.message.startsWith("claude_native_")) throw conflict(UNAVAILABLE);
      throw error;
    }
  };
}
