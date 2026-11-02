import type { Db } from "@paperclipai/db";
import type { PrpEvent, PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { readOpenCodeHost, readOpenCodeTerminalReceipt } from "./opencode-shared-recovery.js";
import type { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { waitForOpenCodeTerminal } from "./opencode-terminal-wakeup.js";

/** Constructed only inside the server from an already persisted lease binding. */
export function createOpenCodeNativePort(db: Db, binding: OpenCodeSharedBinding, host: Awaited<ReturnType<typeof startOpenCodeSharedHost>>) {
  binding = Object.freeze({ ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) });
  const identity = Object.freeze({ runId: binding.runId, sessionId: binding.normalizedSessionId, companyId: binding.companyId, issueId: binding.issueId, agentId: binding.agentId });
  let reading: ReturnType<typeof readOpenCodeTerminalReceipt> | undefined;
  const observationAbort = new AbortController();
  let observation: Promise<void> | undefined;
  function readReceipt() {
    if (reading) return reading;
    const current = readOpenCodeTerminalReceipt(db, binding);
    reading = current;
    void current.finally(() => { if (reading === current) reading = undefined; }).catch(() => {});
    return current;
  }
  return Object.freeze({
    port: Object.freeze({ identity, runnerInstanceId: binding.runnerInstanceId, providerSessionId: binding.providerSessionId,
      async verify() { await readOpenCodeHost(db, binding); await host.verifySession(binding.providerSessionId, binding); },
      readReceipt,
      async dispatch(prompt: { id: string; text: string }) { await host.dispatchForRun(db, binding, prompt); },
      async startObservation() {
        if (observation) throw new Error("opencode_observation_already_started");
        let ready!: () => void;
        const first = new Promise<void>(resolve => { ready = resolve; });
        observation = host.observe(db, binding, observationAbort.signal, item => { if (item.type === "log.synced") ready(); });
        void observation.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([first, observation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("opencode_observation_start_timeout")), 10_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      },
      async waitForReceipt(signal: AbortSignal) {
        if (!observation) throw new Error("opencode_observation_not_started");
        return Promise.race([waitForOpenCodeTerminal(db, binding, signal, readReceipt), observation.then(() => { throw new Error("opencode_observation_ended"); })]);
      },
      async close() { observationAbort.abort(); await observation?.catch(() => {}); },
    }),
    async authorizeWorkSessionResult({ event, result, signal }: { event: PrpEvent; result: PrpStructuredRunResult; signal: AbortSignal }) {
      signal.throwIfAborted();
      const receipt = await readOpenCodeTerminalReceipt(db, binding);
      signal.throwIfAborted();
      return !!receipt && event.eventType === "run.result.proposed" && event.sourceKind === "runner" && event.sourceInstanceId === binding.runnerInstanceId && event.runId === binding.runId && event.normalizedSessionId === binding.normalizedSessionId && event.turnId == null && event.sourceEventId === `opencode:${binding.runId}:${receipt.operationId}` && event.sourceSeq === 1 && event.emittedAt === receipt.recordedAt && nativeSha256(event.payload) === nativeSha256(receipt.result) && nativeSha256(result) === nativeSha256(receipt.result);
    },
  });
}
