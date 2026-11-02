import type { Db } from "@paperclipai/db";
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
export function createOpenCodeManagedMutation(db: Db, input: { binding: OpenCodeSharedBinding; admission: OpenCodeObserverAdmission; fetch?: typeof fetch }) {
  const binding = Object.freeze({ ...input.binding, controllerProcessStartedAt: new Date(input.binding.controllerProcessStartedAt) });
  const identity = Object.freeze({ sessionId: binding.providerSessionId, generation: binding.generation, version: binding.version });
  const attest = input.admission.attest.bind(input.admission);
  const client = new OpenCodeV2Shared({ baseUrl: input.admission.baseUrl, binding: identity, headers: { authorization: input.admission.authorization }, fetch: input.fetch, authority: {
    attest,
    async withMutation<T>(_identity: typeof identity, operation: { id: string; digest: string }, send: () => Promise<T>): Promise<T> {
      const key = `${binding.companyId}:${binding.taskSessionId}:${binding.generation}`;
      return serialize(key, async () => {
        await attest(identity);
        await transitionOpenCodeMutation(db, binding, { ...operation, transition: "reserve" });
        // If anything after this point fails, the durable reservation is an
        // unknown outcome and a future controller must not re-execute it.
        await attest(identity);
        await transitionOpenCodeMutation(db, binding, { ...operation, transition: "check" });
        const result = await send();
        await transitionOpenCodeMutation(db, binding, { ...operation, transition: "acknowledge" });
        return result;
      });
    },
    async loadCursor() { throw new Error("opencode_mutation_cursor_unavailable"); },
    async commitLog() { throw new Error("opencode_mutation_observation_unavailable"); },
  } });
  return Object.freeze({ async dispatch(input: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }) { await client.prompt(input); return { delivery: "acknowledged" as const, taskCompletion: "unproven" as const }; } });
}
