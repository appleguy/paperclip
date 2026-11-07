import { nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { OpenCodeV2Shared } from "../../vendor/paperclip-runner/index.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import type { OpenCodeObserverAdmission } from "./opencode-shared-observer.js";
import { transitionOpenCodeMutation } from "./opencode-shared-recovery.js";

const queues = new Map<string, Promise<void>>();
async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => mine);
  queues.set(key, tail);
  await prior;
  try { return await operation(); }
  finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

/** Controller-internal dispatch. The caller must supply host-owned admission;
 * native owner/external clients are not fenced by this automation queue. */
export function createOpenCodeManagedMutation(db: Db, input: {
  binding: OpenCodeSharedBinding; admission: OpenCodeObserverAdmission; fetch?: typeof fetch;
  /** Tests may shorten the deadline; callers cannot extend the production bound. */
  deliveryTimeoutMs?: number;
}) {
  const deliveryTimeoutMs = input.deliveryTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 10_000)
    throw new Error("opencode_mutation_delivery_timeout_invalid");
  const binding = Object.freeze({ ...input.binding, controllerProcessStartedAt: new Date(input.binding.controllerProcessStartedAt) });
  const identity = Object.freeze({ sessionId: binding.providerSessionId, generation: binding.generation, version: binding.version });
  const hostAttest = input.admission.attest.bind(input.admission);
  const providerFetch = input.fetch ?? globalThis.fetch;
  type Delivery = { controller: AbortController; deadline: number };
  let delivery: Delivery | undefined;
  const assertDelivery = (current: Delivery) => {
    if (delivery !== current) throw new Error("opencode_mutation_delivery_closed");
    if (performance.now() >= current.deadline)
      current.controller.abort(new Error("opencode_mutation_delivery_timeout"));
    current.controller.signal.throwIfAborted();
  };
  const attest: OpenCodeObserverAdmission["attest"] = async target => {
    const current = delivery;
    if (!current) return hostAttest(target);
    assertDelivery(current);
    const signal = current.controller.signal;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Only the read-only host attestation is raced. Its late completion
      // cannot resume this request pipeline after the deadline has rejected it.
      await Promise.race([hostAttest(target), aborted]);
      assertDelivery(current);
    } finally { signal.removeEventListener("abort", onAbort); }
  };
  const fetch: typeof globalThis.fetch = async (resource, init) => {
    const current = delivery;
    if (!current) throw new Error("opencode_mutation_delivery_closed");
    assertDelivery(current);
    const signal = init?.signal
      ? AbortSignal.any([current.controller.signal, init.signal]) : current.controller.signal;
    const response = await providerFetch(resource, { ...init, signal });
    assertDelivery(current);
    // The same signal remains active until prompt() consumes the receipt body.
    return response;
  };
  const client = new OpenCodeV2Shared({ baseUrl: input.admission.baseUrl, binding: identity, headers: { authorization: input.admission.authorization }, fetch, authority: {
    attest,
    async withMutation<T>(_identity: typeof identity, operation: { id: string; digest: string }, send: () => Promise<T>): Promise<T> {
      const key = `${binding.companyId}:${binding.taskSessionId}:${binding.generation}`;
      return serialize(key, async () => {
        await attest(identity);
        // Commit this reservation separately: loss of a response or the later
        // delivery transaction must never erase the unknown-outcome barrier.
        await transitionOpenCodeMutation(db, binding, { ...operation, transition: "reserve" });
        await attest(identity);
        return db.transaction(async transaction => {
          const tx = transaction as unknown as Db;
          // Nested savepoints retain the helper's exact lease/run/issue/session
          // locks until this outer transaction commits or rolls back.
          await transitionOpenCodeMutation(tx, binding, { ...operation, transition: "check" });
          const [lease] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
            .where(and(eq(nativeRunFinalizations.runId, binding.runId),
              gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp() + interval '25 seconds'`))).limit(1);
          if (!lease) throw new Error("opencode_mutation_lease_margin_insufficient");
          const current = { controller: new AbortController(), deadline: performance.now() + deliveryTimeoutMs };
          delivery = current;
          const timer = setTimeout(() => current.controller.abort(new Error("opencode_mutation_delivery_timeout")), deliveryTimeoutMs);
          try {
            // Do not race send() against a timer and release its locks early.
            // Cancellation must settle the request/receipt before rollback.
            const result = await send();
            assertDelivery(current);
            await transitionOpenCodeMutation(tx, binding, { ...operation, transition: "acknowledge" });
            assertDelivery(current);
            return result;
          } finally {
            clearTimeout(timer);
            current.controller.abort(new Error("opencode_mutation_delivery_closed"));
            delivery = undefined;
          }
        });
      });
    },
    async loadCursor() { throw new Error("opencode_mutation_cursor_unavailable"); },
    async commitLog() { throw new Error("opencode_mutation_observation_unavailable"); },
  } });
  return Object.freeze({ async dispatch(input: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean; agent?: string }) { await client.prompt(input); return { delivery: "acknowledged" as const, taskCompletion: "unproven" as const }; } });
}
