import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { NativeSession, NativeSessionBackend, OpenNativeSessionInput, PersistedNativeSession } from "../../contracts/native-session-backend.js";
import type { NativeRunIdentity } from "../../contracts/types.js";
import type { PrpStructuredRunResult } from "../../protocol/replay-contract.js";

/** Only the embedding server can supply this port, after exact lease admission and a real native launch. */
export interface ClaudeInteractiveNativePort {
  identity: NativeRunIdentity;
  runnerInstanceId: string;
  nativeSessionId: string;
  /** Exact live process, native session and lease checks; throws when anything changed. */
  verify(): Promise<void>;
  readReceipt(): Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string } | null>;
  /** Controller-originated task prompt. Delivery is a terminal write attempt, never an acknowledgement. */
  dispatch(input: { id: string; text: string }): Promise<void>;
  waitForReceipt(signal: AbortSignal): Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string }>;
  close(): Promise<void>;
}

/** Owner input and interrupt are never gated by this backend; they reach the same PTY through the managed service.
 * No native Stop, visible text or turn event completes work: only an authenticated finish/block receipt does. */
const capabilities = { resume: false, typedEvents: true, steering: false, interruption: false, structuredResult: true,
  completionBoundary: "paperclip_work_session" as const, providerTermination: "unavailable" as const, dynamicTools: true };
const identityMatches = (a: NativeRunIdentity, b: NativeRunIdentity) => a.runId === b.runId && a.sessionId === b.sessionId && a.companyId === b.companyId && a.issueId === b.issueId && a.agentId === b.agentId;

export class ClaudeInteractiveNativeBackend implements NativeSessionBackend {
  constructor(private readonly port: ClaudeInteractiveNativePort) {}
  static async transcriptPeak(input: { home: string; claudeConfigDir?: string; cwd: string; sessionId: string }): Promise<number | undefined> {
    if (!isAbsolute(input.home) || !isAbsolute(input.cwd) || (input.claudeConfigDir && !isAbsolute(input.claudeConfigDir))
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId)) throw new Error("claude_transcript_scope_invalid");
    const project = (await realpath(resolve(input.cwd))).replace(/[^a-zA-Z0-9]/g, "-");
    const path = join(input.claudeConfigDir ?? join(input.home, ".claude"), "projects", project, `${input.sessionId}.jsonl`);
    let peak = 0;
    try {
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of lines) {
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "assistant" || (entry.sessionId ?? entry.session_id) !== input.sessionId) continue;
        const usage = entry.message?.usage;
        if (!usage || typeof usage !== "object") continue;
        const values = [usage.input_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0, usage.output_tokens];
        if (!values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) continue;
        const total = values.reduce((sum, value) => sum + value, 0);
        if (Number.isSafeInteger(total) && total <= 2_147_483_647) peak = Math.max(peak, total);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return peak || undefined;
  }
  async descriptor() {
    return { kind: "runner" as const, name: "claude_interactive_v1", version: "1", capabilities,
      runtimeContextCapabilities: { instructions: "native" as const, skills: "native" as const, mcp: "native" as const } };
  }
  async openSession(input: OpenNativeSessionInput): Promise<NativeSession> {
    const port = this.port;
    // The server launched and registered the real session before this call. If no NativeSession is returned, nobody else will
    // settle it: release it here, but only when no tool effect is unsettled (port.close refuses then and the session stays
    // retained). The original failure is what the caller sees.
    try { return await this.open(input); }
    catch (error) { await port.close().catch(() => undefined); throw error; }
  }
  private async open(input: OpenNativeSessionInput): Promise<NativeSession> {
    const port = this.port;
    if (!identityMatches(input.identity, port.identity) || !port.runnerInstanceId || port.nativeSessionId !== input.identity.sessionId) throw new Error("claude_interactive_backend_identity_mismatch");
    input.signal?.throwIfAborted();
    await port.verify();
    input.signal?.throwIfAborted();
    const abort = new AbortController();
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
        if (!/^[a-f0-9]{64}$/.test(receipt.operationId) || !Number.isFinite(Date.parse(receipt.recordedAt))) throw new Error("claude_interactive_receipt_invalid");
        yield { schema: "paperclip.prp.event.v1", sourceEventId: `claude:${port.identity.runId}:${receipt.operationId}`, sourceSeq: 1,
          sourceInstanceId: port.runnerInstanceId, sourceKind: "runner", runId: port.identity.runId, normalizedSessionId: port.identity.sessionId,
          eventType: "run.result.proposed", schemaVersion: 1, priority: 0, emittedAt: receipt.recordedAt, payload: receipt.result };
      },
      async startTurn({ message }) {
        if (started || abort.signal.aborted || message.role !== "user") throw new Error("claude_interactive_dispatch_unavailable");
        started = true;
        try {
          // A committed result survives controller loss: never re-prompt the session for it.
          const prior = await port.readReceipt();
          const id = prior ? "work_session_receipt" : `claude_${randomUUID()}`;
          if (!prior) await port.dispatch({ id, text: message.text });
          releaseStart();
          return { turnId: id };
        } catch (error) { rejectStart(error); throw error; }
      },
      async result() { return null; },
      async snapshot(): Promise<PersistedNativeSession> {
        return { backendKind: "runner", driverKind: "claude_interactive_v1", sessionId: input.identity.sessionId, identity: { ...input.identity }, providerSessionId: port.nativeSessionId, cursor: null };
      },
      async close() { abort.abort(new Error("claude_interactive_controller_closed")); rejectStart(new Error("claude_interactive_controller_closed")); await port.close(); },
    };
    return session;
  }
}
