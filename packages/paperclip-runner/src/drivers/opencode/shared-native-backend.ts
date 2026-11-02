import { randomUUID } from "node:crypto";
import type { NativeSession, NativeSessionBackend, OpenNativeSessionInput, PersistedNativeSession } from "../../contracts/native-session-backend.js";
import type { NativeRunIdentity } from "../../contracts/types.js";
import type { PrpStructuredRunResult } from "../../protocol/replay-contract.js";

/** Only the embedding server can supply this port after exact lease admission. */
export interface OpenCodeSharedNativePort {
  identity: NativeRunIdentity;
  runnerInstanceId: string;
  providerSessionId: string;
  verify(): Promise<void>;
  readReceipt(): Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string } | null>;
  dispatch(input: { id: string; text: string }): Promise<void>;
  startObservation(): Promise<void>;
  waitForReceipt(signal: AbortSignal): Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string }>;
  close(): Promise<void>;
}

const capabilities = { resume: false, typedEvents: true, steering: false, interruption: false, structuredResult: true,
  completionBoundary: "paperclip_work_session" as const, providerTermination: "unavailable" as const, dynamicTools: true };
const identityMatches = (a: NativeRunIdentity, b: NativeRunIdentity) => a.runId === b.runId && a.sessionId === b.sessionId && a.companyId === b.companyId && a.issueId === b.issueId && a.agentId === b.agentId;

export class OpenCodeSharedNativeBackend implements NativeSessionBackend {
  constructor(private readonly port: OpenCodeSharedNativePort) {}
  async descriptor() { return { kind: "runner" as const, name: "opencode_shared_v2", version: "2.2.5", capabilities, runtimeContextCapabilities: { instructions: "native" as const, skills: "native" as const, mcp: "native" as const } }; }
  async openSession(input: OpenNativeSessionInput): Promise<NativeSession> {
    if (!identityMatches(input.identity, this.port.identity) || !/^ses_[A-Za-z0-9_-]+$/.test(this.port.providerSessionId) || !this.port.runnerInstanceId) throw new Error("opencode_shared_backend_identity_mismatch");
    input.signal?.throwIfAborted();
    await this.port.verify();
    input.signal?.throwIfAborted();
    const port = this.port, abort = new AbortController();
    let started = false;
    let releaseStart!: () => void, rejectStart!: (error: unknown) => void;
    const startedGate = new Promise<void>((resolve, reject) => { releaseStart = resolve; rejectStart = reject; });
    void startedGate.catch(() => {});
    const session: NativeSession = {
      identity: () => ({ ...input.identity }),
      async capabilities() { return capabilities; },
      async *events() {
        await startedGate;
        const receipt = await port.waitForReceipt(abort.signal);
        abort.signal.throwIfAborted();
        if (!/^[a-f0-9]{64}$/.test(receipt.operationId) || !Number.isFinite(Date.parse(receipt.recordedAt))) throw new Error("opencode_shared_receipt_invalid");
        yield { schema: "paperclip.prp.event.v1", sourceEventId: `opencode:${port.identity.runId}:${receipt.operationId}`, sourceSeq: 1,
          sourceInstanceId: port.runnerInstanceId, sourceKind: "runner", runId: port.identity.runId, normalizedSessionId: port.identity.sessionId,
          eventType: "run.result.proposed", schemaVersion: 1, priority: 0, emittedAt: receipt.recordedAt, payload: receipt.result };
      },
      async startTurn({ message }) {
        if (started || abort.signal.aborted || message.role !== "user") throw new Error("opencode_shared_dispatch_unavailable");
        started = true;
        try {
          // A committed result survives controller loss. Never send a new
          // prompt merely because its prior controller did not finish PRP.
          const prior = await port.readReceipt();
          const id = prior ? "work_session_receipt" : `msg_${randomUUID()}`;
          if (!prior) await port.dispatch({ id, text: message.text });
          await port.startObservation();
          releaseStart();
          return { turnId: id };
        } catch (error) { rejectStart(error); throw error; }
      },
      async result() { return null; },
      async snapshot(): Promise<PersistedNativeSession> { return { backendKind: "runner", driverKind: "opencode_shared_v2", sessionId: input.identity.sessionId, identity: { ...input.identity }, providerSessionId: port.providerSessionId, cursor: null }; },
      async close() { abort.abort(new Error("opencode_shared_controller_closed")); rejectStart(new Error("opencode_shared_controller_closed")); await port.close(); },
    };
    return session;
  }
}
