import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueRecoveryActions } from "@paperclipai/db";
import type {
  BoardOperatorConfig,
  IssueThreadInteractionKind,
  IssueThreadInteractionResolverPolicy,
} from "@paperclipai/shared";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";

/**
 * The Board operator is an AI agent the company designates to be woken first
 * for agent questions and board-owned recovery escalations. It is only woken:
 * it gains no authority from this setting, and every action it takes still goes
 * through its own credentials and the normal route authorization.
 */
export const BOARD_RECOVERY_ESCALATED_WAKE_REASON = "board_recovery_escalated";

/** Server-provided triage guidance that travels with a Board operator wake. */
export const BOARD_OPERATOR_TRIAGE_GUIDANCE =
  "Answer what you can from the issue, documents and code. Continue with the safest reversible choice instead of blocking. " +
  "Ask the owner (a new human_only interaction) only for spend, irreversible or outward-facing actions, or a taste/direction choice only the owner can make. " +
  "When you escalate, answer the agent's question with a reversible default and a link to the owner question.";

export const DEFAULT_BOARD_OPERATOR_CONFIG: BoardOperatorConfig = {
  agentId: null,
  routeAgentQuestions: false,
  wakeOnRecoveryEscalation: false,
};

export function normalizeBoardOperatorConfig(raw: unknown): BoardOperatorConfig {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    agentId: typeof value.agentId === "string" && value.agentId.length > 0 ? value.agentId : null,
    routeAgentQuestions: value.routeAgentQuestions === true,
    wakeOnRecoveryEscalation: value.wakeOnRecoveryEscalation === true,
  };
}

export async function getBoardOperatorConfig(db: Db, companyId: string): Promise<BoardOperatorConfig> {
  const row = await db
    .select({ boardOperator: companies.boardOperator })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return normalizeBoardOperatorConfig(row?.boardOperator);
}

/** Returns the operator agent id only when it exists in the company and can be invoked. */
export async function getInvokableBoardOperatorAgentId(
  db: Db,
  companyId: string,
  config: BoardOperatorConfig,
): Promise<string | null> {
  if (!config.agentId) return null;
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(and(eq(agents.id, config.agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;
  const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
  return invokability.invokable ? agent.id : null;
}

/**
 * Only plain questions are routed. Confirmations, quality reviews, tool/secret
 * governance and independent-review policies keep their human audience, so the
 * operator can never approve something the owner meant to approve.
 */
export function isBoardRoutableQuestion(input: {
  kind: IssueThreadInteractionKind;
  requestedPolicy?: IssueThreadInteractionResolverPolicy;
  hasToolAction: boolean;
  hasSecretProposal: boolean;
  hasQualityReview: boolean;
}): boolean {
  if (input.kind !== "ask_user_questions") return false;
  if (input.hasToolAction || input.hasSecretProposal || input.hasQualityReview) return false;
  const requested = input.requestedPolicy;
  // `human_only` is the common over-restriction on plain questions; the
  // operator decides whether the owner actually needs to see it.
  return requested === undefined
    || requested === "anyone"
    || requested === "board_or_agents"
    || requested === "human_only"
    || requested === "board_only";
}

export async function resolveBoardOperatorQuestionRoute(
  db: Db,
  input: {
    companyId: string;
    creatorAgentId: string;
    requestedPolicy?: IssueThreadInteractionResolverPolicy;
    kind: IssueThreadInteractionKind;
    hasToolAction: boolean;
    hasSecretProposal: boolean;
    hasQualityReview: boolean;
  },
): Promise<{ addresseeAgentId: string } | null> {
  if (!isBoardRoutableQuestion(input)) return null;
  const config = await getBoardOperatorConfig(db, input.companyId);
  if (!config.routeAgentQuestions || !config.agentId) return null;
  // The operator's own questions are the escalation path to the human.
  if (config.agentId === input.creatorAgentId) return null;
  const operatorId = await getInvokableBoardOperatorAgentId(db, input.companyId, config);
  return operatorId ? { addresseeAgentId: operatorId } : null;
}

type WakeDeps = {
  wakeup(agentId: string, opts: Record<string, unknown>): Promise<unknown>;
};

/**
 * Wakes the company's Board operator once per board-owned recovery action.
 * Idempotent by action id, so repeated sweeps never re-wake an action the
 * operator already received; the operator's own heartbeat sweep is the backstop.
 */
export function boardOperatorRecoveryService(db: Db, deps: WakeDeps) {
  return {
    async wakeForBoardOwnedRecoveryActions(options: { limit?: number } = {}) {
      const rows = await db
        .select({
          id: issueRecoveryActions.id,
          companyId: issueRecoveryActions.companyId,
          sourceIssueId: issueRecoveryActions.sourceIssueId,
          kind: issueRecoveryActions.kind,
          cause: issueRecoveryActions.cause,
          boardOperator: companies.boardOperator,
        })
        .from(issueRecoveryActions)
        .innerJoin(companies, eq(companies.id, issueRecoveryActions.companyId))
        .where(
          and(
            eq(issueRecoveryActions.ownerType, "board"),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
            sql`${companies.boardOperator}->>'wakeOnRecoveryEscalation' = 'true'`,
            sql`${companies.boardOperator}->>'agentId' is not null`,
          ),
        )
        .orderBy(desc(issueRecoveryActions.createdAt))
        .limit(options.limit ?? 50);

      const result = { considered: rows.length, woken: 0, skipped: 0 };
      for (const row of rows) {
        const config = normalizeBoardOperatorConfig(row.boardOperator);
        const operatorId = await getInvokableBoardOperatorAgentId(db, row.companyId, config);
        if (!operatorId) {
          result.skipped += 1;
          continue;
        }
        try {
          const queued = await deps.wakeup(operatorId, {
            source: "automation",
            triggerDetail: "system",
            reason: BOARD_RECOVERY_ESCALATED_WAKE_REASON,
            payload: {
              issueId: row.sourceIssueId,
              recoveryActionId: row.id,
              recoveryKind: row.kind,
              recoveryCause: row.cause,
              mutation: "recovery_action",
            },
            idempotencyKey: `board-recovery:${row.id}`,
            requestedByActorType: "system",
            requestedByActorId: null,
            contextSnapshot: {
              issueId: row.sourceIssueId,
              taskId: row.sourceIssueId,
              recoveryActionId: row.id,
              recoveryKind: row.kind,
              recoveryCause: row.cause,
              wakeReason: BOARD_RECOVERY_ESCALATED_WAKE_REASON,
              source: "board_operator.recovery_escalation",
              boardOperatorGuidance: BOARD_OPERATOR_TRIAGE_GUIDANCE,
            },
          });
          if (queued) result.woken += 1;
          else result.skipped += 1;
        } catch {
          result.skipped += 1;
        }
      }
      return result;
    },
  };
}
