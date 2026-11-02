import { createHash } from "node:crypto";
import type { CodexAppServerTransport } from "./app-server-transport.js";

/**
 * SCO-378 research-only adapter between a Paperclip-owned session goal and
 * an already-existing Codex app-server thread.
 *
 * Security boundary: the *server* owns authorization and the durable journal.
 * The native daemon's threadId is identity, never an authorization token.
 * No production caller is currently wired to this adapter.
 */
export type NativeGoalAction = "set_paused" | "edit_paused" | "clear_paused";
export type NativeGoalRejection =
  | "not_paperclip_owned" | "missing_exclusive_writer"
  | "stale_authority" | "wrong_thread" | "wrong_goal"
  | "missing_goal" | "unexpected_existing_goal"
  | "active_goal_requires_safe_handoff" | "invalid_objective"
  | "invalid_budget" | "invalid_operation" | "reconcile_before_retry";

export class NativeGoalGateError extends Error {
  constructor(readonly reason: NativeGoalRejection) {
    super(reason);
    this.name = "NativeGoalGateError";
  }
}
const deny = (reason: NativeGoalRejection): never => { throw new NativeGoalGateError(reason); };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export interface PaperclipGoalControlPin {
  // These are server-issued identities, NOT trusted browser inputs.
  companyId: string;
  projectId: string;
  issueId: string;
  agentId: string;
  paperclipGoalId: string;
  taskSessionId: string;
  runId: string;
  nativeThreadId: string;
  provider: "codex";
  protocolVersion: string;
  model: string;
  effort: string;
  writerGrantId: string;
  writerEpoch: number;
  goalRevision: number;
  /** Durable source receipt from the previous accepted mutation; null means absent. */
  expectedSourceGoalDigest: string | null;
  runCheckedOut: boolean;
  exclusiveNativeWriterVerified: boolean;
  nativeProcessGeneration: string;
  issueStatus: "in_progress" | "todo" | "blocked" | "done" | "cancelled";
}

export interface GoalControlRequest {
  requestId: string;
  action: NativeGoalAction;
  expectedRevision: number;
  objective?: string;
  tokenBudget?: number;
}

/** Journal adapters must be backed by *durable* Paperclip unique constraints. */
export interface PaperclipGoalJournal {
  /** Never return true for an already-seen request, even if its prior ACK was lost. */
  reserveOnce(input: {
    companyId: string; issueId: string; goalId: string; runId: string;
    taskSessionId: string; nativeThreadId: string;
    writerGrantId: string; writerEpoch: number; requestId: string;
    expectedRevision: number; action: NativeGoalAction;
    inputDigest: string;
  }): Promise<"fresh" | "existing_or_uncertain">;
  /**
   * One immutable source-bound acknowledgement. Losing this commit response
   * does NOT authorize replaying the provider command.
   */
  commitSourceReceipt(input: {
    requestId: string; nativeThreadId: string; sourceGoalDigest: string;
    sourceStatus: "paused" | "cleared"; writerGrantId: string;
    writerEpoch: number;
  }): Promise<void>;
}

/** Source of authority must recheck DB checkout, lease, run and provider generation. */
export type FreshPaperclipGoalAuthority =
  (pin: PaperclipGoalControlPin) => Promise<PaperclipGoalControlPin>;

/** Redacted result: native objective remains in the provider's private store. */
export interface NativeGoalReceipt {
  requestId: string;
  nativeThreadId: string;
  status: "paused" | "cleared";
  objectiveDigest: string | null;
  sourceGoalDigest: string;
  tokenBudget: number | null;
  /** Receipt says only that the goal *configuration* settled, not a task result. */
  paperclipRunCompleted: false;
  modelTurnStarted: false;
}
interface NativeGoal { threadId: string; status: string; objective: string; tokenBudget: number | null; }
const goalDigest = (goal: NativeGoal): string => sha256(JSON.stringify({
  threadId: goal.threadId, objective: goal.objective,
  status: goal.status, tokenBudget: goal.tokenBudget,
}));

function validGoal(value: unknown, nativeThreadId: string): NativeGoal | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return deny("wrong_thread");
  const goal = value as Record<string, unknown>;
  if (goal.threadId !== nativeThreadId || !nonempty(goal.objective) ||
      !nonempty(goal.status)) return deny("wrong_thread");
  return {
    threadId: nativeThreadId,
    status: goal.status,
    objective: goal.objective,
    tokenBudget: Number.isSafeInteger(goal.tokenBudget) ?
      Number(goal.tokenBudget) : null,
  };
}
export function verifiedNativeGoalSnapshot(response: unknown, nativeThreadId: string): NativeGoal | null {
  if (!response || typeof response !== "object" ||
      !Object.prototype.hasOwnProperty.call(response, "goal"))
    return deny("wrong_thread");
  return validGoal((response as {goal: unknown}).goal, nativeThreadId);
}
function validBudget(n: number | undefined): boolean {
  return n === undefined || (Number.isSafeInteger(n) && n >= 1 && n <= 100_000_000);
}

/**
 * For now only PAUSED native goals can be configured. Codex starts a model
 * turn when an idle goal is activated; enabling active/resume requires an
 * independent Paperclip host/model lease AND a provider-enforced mobile writer
 * handoff. Neither can be inferred from a native goal API acknowledgment.
 */
export class ManagedNativeCodexGoalBridge {
  constructor(
    private readonly native: Pick<CodexAppServerTransport, "request">,
    private readonly freshAuthority: FreshPaperclipGoalAuthority,
    private readonly journal: PaperclipGoalJournal,
  ) {}

  private async authorize(pin: PaperclipGoalControlPin): Promise<void> {
    if (![pin.companyId, pin.projectId, pin.issueId, pin.agentId,
      pin.paperclipGoalId, pin.taskSessionId, pin.runId, pin.nativeThreadId,
      pin.protocolVersion, pin.model, pin.effort, pin.nativeProcessGeneration,
      pin.writerGrantId].every(nonempty) || !Number.isSafeInteger(pin.writerEpoch) ||
        pin.writerEpoch < 1 || pin.provider !== "codex")
      deny("not_paperclip_owned");
    const actual = await this.freshAuthority(pin);
    if (!actual || actual.provider !== "codex" || actual.companyId !== pin.companyId ||
        actual.projectId !== pin.projectId ||
        actual.issueId !== pin.issueId || actual.agentId !== pin.agentId ||
        actual.paperclipGoalId !== pin.paperclipGoalId ||
        actual.taskSessionId !== pin.taskSessionId ||
        actual.runId !== pin.runId || actual.nativeThreadId !== pin.nativeThreadId ||
        actual.nativeProcessGeneration !== pin.nativeProcessGeneration ||
        actual.writerGrantId !== pin.writerGrantId ||
        actual.writerEpoch !== pin.writerEpoch ||
        actual.goalRevision !== pin.goalRevision ||
        actual.expectedSourceGoalDigest !== pin.expectedSourceGoalDigest ||
        actual.model !== pin.model || actual.effort !== pin.effort ||
        actual.protocolVersion !== pin.protocolVersion)
      deny("stale_authority");
    if (!actual.runCheckedOut || actual.issueStatus !== "in_progress")
      deny("not_paperclip_owned");
    if (!actual.exclusiveNativeWriterVerified)
      deny("missing_exclusive_writer");
  }

  /** Read is metadata observation; it still binds an actual source-native ID. */
  async read(pin: PaperclipGoalControlPin): Promise<{
    configured: boolean; status: string | null;
    objectiveDigest: string | null; tokenBudget: number | null;
  }> {
    // Never expose the objective in a dashboard or Paperclip audit event.
    if (!nonempty(pin.nativeThreadId)) deny("wrong_thread");
    // This writer-side bridge has no public observer mode. Metadata reads
    // require the same fresh Paperclip checkout and exact native writer pin.
    await this.authorize(pin);
    const response = await this.native.request("thread/goal/get", { threadId: pin.nativeThreadId });
    const goal = verifiedNativeGoalSnapshot(response, pin.nativeThreadId);
    return {
      configured: goal !== null, status: goal?.status ?? null,
      objectiveDigest: goal ? sha256(goal.objective) : null,
      tokenBudget: goal?.tokenBudget ?? null,
    };
  }

  async applyPaused(pin: PaperclipGoalControlPin, request: GoalControlRequest): Promise<NativeGoalReceipt> {
    // This is an additional gate. Real production also needs server-minted
    // admission and a provider socket behind that server's single writer.
    if (!nonempty(request.requestId) || request.requestId.length > 128 ||
        !["set_paused", "edit_paused", "clear_paused"].includes(request.action) ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision !== pin.goalRevision) deny("invalid_operation");
    if (!validBudget(request.tokenBudget)) deny("invalid_budget");
    if (request.action !== "clear_paused" &&
        request.action === "set_paused" &&
        (!nonempty(request.objective) || request.objective.length > 4000))
      deny("invalid_objective");
    if (request.action === "clear_paused" &&
        (request.objective !== undefined || request.tokenBudget !== undefined))
      deny("invalid_operation");
    await this.authorize(pin);

    const before = verifiedNativeGoalSnapshot(
      await this.native.request("thread/goal/get", { threadId: pin.nativeThreadId }),
      pin.nativeThreadId,
    );
    if (before && before.status !== "paused") deny("active_goal_requires_safe_handoff");
    if ((before ? goalDigest(before) : null) !== pin.expectedSourceGoalDigest)
      deny("wrong_goal");
    if (request.action === "set_paused" && before !== null) deny("unexpected_existing_goal");
    if (request.action !== "set_paused" && before === null) deny("missing_goal");
    if (request.action === "edit_paused" &&
        request.objective !== undefined &&
        (!nonempty(request.objective) || request.objective.length > 4000))
      deny("invalid_objective");
    // The provider may have changed while we were reading it. Source-bound
    // grant readback immediately precedes reservation and send.
    await this.authorize(pin);
    const inputDigest = sha256(JSON.stringify({
      requestId: request.requestId, action: request.action,
      expectedRevision: request.expectedRevision,
      objective: request.objective ?? null,
      tokenBudget: request.tokenBudget ?? null,
      previousObjectiveDigest: before ? sha256(before.objective) : null,
    }));
    const reserved = await this.journal.reserveOnce({
      companyId: pin.companyId, issueId: pin.issueId,
      goalId: pin.paperclipGoalId, runId: pin.runId,
      taskSessionId: pin.taskSessionId, nativeThreadId: pin.nativeThreadId,
      writerGrantId: pin.writerGrantId, writerEpoch: pin.writerEpoch,
      requestId: request.requestId, expectedRevision: request.expectedRevision,
      action: request.action, inputDigest,
    });
    if (reserved !== "fresh") deny("reconcile_before_retry");
    // From here, any timeout or crash is UNCERTAIN, never a safe retry.
    await this.authorize(pin);
    const method = request.action === "clear_paused" ?
      "thread/goal/clear" : "thread/goal/set";
    const params: Record<string, unknown> = { threadId: pin.nativeThreadId };
    if (method === "thread/goal/set") {
      params.status = "paused";
      if (request.objective !== undefined) params.objective = request.objective;
      if (request.tokenBudget !== undefined) params.tokenBudget = request.tokenBudget;
    }
    const applied = verifiedNativeGoalSnapshot(
      await this.native.request(method, params), pin.nativeThreadId,
    );
    if (request.action === "clear_paused" ? applied !== null :
        !applied || applied.status !== "paused" ||
        (request.objective !== undefined && applied.objective !== request.objective) ||
        (request.tokenBudget !== undefined && applied.tokenBudget !== request.tokenBudget)) {
      deny("reconcile_before_retry");
    }
    const authoritative = verifiedNativeGoalSnapshot(
      await this.native.request("thread/goal/get", { threadId: pin.nativeThreadId }),
      pin.nativeThreadId,
    );
    if (request.action === "clear_paused" ? authoritative !== null :
        !authoritative || authoritative.status !== "paused" ||
        authoritative.objective !== applied?.objective ||
        authoritative.tokenBudget !== applied?.tokenBudget)
      deny("reconcile_before_retry");

    // A receipt must not be committed under an expired or replaced writer.
    // A failure here leaves the reserved intent uncertain for reconciliation.
    await this.authorize(pin);
    const status = authoritative === null ? "cleared" as const : "paused" as const;
    const sourceGoalDigest = authoritative ? goalDigest(authoritative) : sha256("goal:cleared:"+pin.nativeThreadId);
    await this.journal.commitSourceReceipt({
      requestId: request.requestId,
      nativeThreadId: pin.nativeThreadId,
      sourceGoalDigest, sourceStatus: status,
      writerGrantId: pin.writerGrantId, writerEpoch: pin.writerEpoch,
    });
    return {
      requestId: request.requestId, nativeThreadId: pin.nativeThreadId,
      status, objectiveDigest: authoritative ? sha256(authoritative.objective) : null,
      sourceGoalDigest,
      tokenBudget: authoritative?.tokenBudget ?? null,
      paperclipRunCompleted: false, modelTurnStarted: false,
    };
  }
}
