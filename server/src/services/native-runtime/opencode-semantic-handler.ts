import type { Db } from "@paperclipai/db";
import { validatePrpStructuredRunResult, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { isOpenCodeSemanticCallReserved, transitionOpenCodeSemanticCall } from "./opencode-shared-recovery.js";
import { notifyOpenCodeTerminal } from "./opencode-terminal-wakeup.js";

/** Controller-only handler. The supplied callbacks are the existing native
 * tool authority and completion-feedback boundary for this admitted run. */
export function createOpenCodeSemanticHandler(db: Db, binding: OpenCodeSharedBinding, authority: {
  execute: (call: { tool: string; callId: string; arguments: unknown }) => Promise<unknown>;
  recover?: (call: { tool: string; callId: string; arguments: unknown }) => Promise<{ result: unknown; isError?: boolean } | null>;
  completionFeedback: (result: PrpStructuredRunResult) => Promise<string>;
  completionContract: { revision: string | number; criterionIds: readonly string[] };
}) {
  binding = Object.freeze({ ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) });
  return async (call: { tool: string; callId: string; arguments: unknown; signal: AbortSignal }) => {
    if (call.signal.aborted) throw new Error("opencode_semantic_cancelled");
    const receipt = { callId: call.callId, tool: call.tool, arguments: call.arguments };
    let semantic: PrpStructuredRunResult | undefined;
    if (call.tool === "paperclip_finish" || call.tool === "paperclip_block") {
      const validated = validatePrpStructuredRunResult(call.arguments);
      if (!validated.ok) throw new Error("opencode_semantic_result_invalid");
      semantic = validated.result;
      const received = semantic.completionClaim.criteria.map(criterion => criterion.criterionId);
      const expected = authority.completionContract.criterionIds;
      if ((call.tool === "paperclip_block") !== (semantic.reportedWorkDisposition === "blocked") || semantic.completionClaim.contractRevision !== authority.completionContract.revision || received.length !== expected.length || new Set(received).size !== received.length || received.some(id => !expected.includes(id))) throw new Error("opencode_semantic_contract_mismatch");
    }
    try { await transitionOpenCodeSemanticCall(db, binding, receipt); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "opencode_semantic_outcome_unknown_or_recorded" || !authority.recover || semantic || !(await isOpenCodeSemanticCallReserved(db, binding, receipt))) throw error;
      const recovered = await authority.recover(receipt);
      if (!recovered) throw new Error("opencode_semantic_outcome_unknown");
      await transitionOpenCodeSemanticCall(db, binding, { ...receipt, outcome: { result: recovered.result, isError: recovered.isError === true } });
      if (recovered.isError) throw new Error("opencode_semantic_recovered_failure");
      return recovered.result;
    }
    // Any error or process loss after reservation leaves an uncertain outcome.
    // Never repeat it, including a rejected feedback call.
    if (call.signal.aborted) throw new Error("opencode_semantic_outcome_unknown");
    let result: unknown;
    if (semantic) {
      const feedback = await authority.completionFeedback(semantic);
      if (typeof feedback !== "string" || !feedback.trim()) throw new Error("opencode_semantic_feedback_invalid");
      result = { feedback, result: semantic };
    } else result = await authority.execute(receipt);
    await transitionOpenCodeSemanticCall(db, binding, { ...receipt, outcome: { result, isError: false } });
    if (semantic) notifyOpenCodeTerminal(binding);
    return result;
  };
}
