import { agentTaskSessions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { OpenCodeV2Shared, type V2Binding, type V2Cursor, type V2Event } from "../../vendor/paperclip-runner/index.js";
import { commitOpenCodeSharedLog, type OpenCodeSharedBinding } from "./opencode-shared-authority.js";

/** Internal capability: callers must obtain this from host-owned admission, never HTTP input. */
export type OpenCodeObserverAdmission = Readonly<{
  baseUrl: string;
  authorization: string;
  attest: (binding: V2Binding) => Promise<void>;
}>;

const keys = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort"] as const;

/** Observe an already admitted backend; no prompt or provider mutation is exposed.
 * This is not an admission factory. Production callers must supply a host-authenticated
 * generation and the current controller's exact lease, neither from request data. */
export function createOpenCodeSharedObserver(db: Db, input: {
  binding: OpenCodeSharedBinding;
  admission: OpenCodeObserverAdmission;
  fetch?: typeof fetch;
  onObserved?: (item: V2Event) => void;
}) {
  const binding = Object.freeze({ ...input.binding, controllerProcessStartedAt: new Date(input.binding.controllerProcessStartedAt) });
  const identity: V2Binding = Object.freeze({ sessionId: binding.providerSessionId, generation: binding.generation, version: binding.version });
  const attest = input.admission.attest.bind(input.admission);
  const client = new OpenCodeV2Shared({ baseUrl: input.admission.baseUrl, binding: identity,
    headers: { authorization: input.admission.authorization }, fetch: input.fetch,
    authority: {
      attest,
      async withMutation() { throw new Error("opencode_shared_mutation_not_admitted"); },
      async loadCursor(): Promise<V2Cursor> {
        await attest(identity);
        const [session] = await db.select().from(agentTaskSessions).where(and(
          eq(agentTaskSessions.id, binding.taskSessionId), eq(agentTaskSessions.companyId, binding.companyId),
          eq(agentTaskSessions.agentId, binding.agentId), eq(agentTaskSessions.lastRunId, binding.runId),
          eq(agentTaskSessions.adapterType, "paperclip_runner"),
        )).limit(1);
        const native = (session?.sessionParamsJson as Record<string, unknown> | undefined)?.opencodeSharedV2;
        if (!native || typeof native !== "object" || Array.isArray(native)) throw new Error("opencode_shared_session_mismatch");
        const record = native as Record<string, unknown>;
        if (keys.some(key => record[key] !== binding[key]) || !(record.cursor === null || (Number.isSafeInteger(record.cursor) && Number(record.cursor) >= 0))) throw new Error("opencode_shared_cursor_or_identity_mismatch");
        return { ...identity, seq: record.cursor as number | null };
      },
      async commitLog(_identity: V2Binding, previous: number | null, next: number | null, item: V2Event) {
        await attest(identity);
        await commitOpenCodeSharedLog(db, binding, { previous, next, item });
        input.onObserved?.(item);
      },
    },
  });
  return Object.freeze({
    async observe(signal?: AbortSignal) { await client.verifySession(); await client.follow(signal); },
  });
}
