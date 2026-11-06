import { createHash } from "node:crypto";
import { NativeOwnerCommandJournal } from "../drivers/claude/native-owner-command-journal.js";
import { modelUsage, parseModelRequest, type ModelFamily, type ModelRequest, type ModelResult } from "./model-invocation-contract.js";

/** Internal adapter contract. No production provider is qualified yet. */
export interface IsolatedModelProvider {
  readonly family: ModelFamily;
  /** Must be implemented by a qualified provider, not inferred from a prompt. */
  invokeFreshToolsOff(input: { request: ModelRequest; signal: AbortSignal }): Promise<{
    response: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The provider may have started even if cancellation raced its return.
  void promise.catch(() => {});
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("model invocation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reserve before any provider action. A prior or damaged reservation always
 * requires reconciliation; neither a cancellation nor a lost response can
 * cause this operation id to be sent again. The caller owns schema validation
 * and response publication; neither secrets nor prompt text enter the journal.
 * This primitive does not qualify a provider or expose an external API.
 */
export async function invokeIsolatedModel(input: {
  request: unknown;
  operationId: string;
  journalDirectory: string;
  provider: IsolatedModelProvider;
  signal: AbortSignal;
  validateResponse: (response: string) => void;
}): Promise<ModelResult> {
  const request = parseModelRequest(input.request);
  if (input.provider.family !== request.family) throw new Error("provider family mismatch");
  input.signal.throwIfAborted();
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  // The existing exclusive, fsynced journal supplies the reservation. This
  // is deliberately independent of a live seat or its process generation.
  const journal = new NativeOwnerCommandJournal({
    directory: input.journalDirectory, sessionId: "model-invocation", processGeneration: "v1",
  });
  const reservation = await journal.begin({
    operationId: input.operationId, sessionId: "model-invocation", processGeneration: "v1", inputSha256: digest,
  });
  if (reservation !== "reserved") throw new Error("model invocation outcome uncertain; reconcile before retry");
  input.signal.throwIfAborted();
  const start = process.hrtime.bigint();
  // An adapter must also cancel its own provider work. If it fails to settle,
  // bound the caller and retain the reservation as uncertain, never resend.
  const result = await abortable(input.provider.invokeFreshToolsOff({ request, signal: input.signal }), input.signal);
  input.signal.throwIfAborted();
  if (typeof result.response !== "string") throw new Error("provider response must be text");
  input.validateResponse(result.response);
  return {
    family: request.family, role: request.role, response: result.response,
    usage: modelUsage(result.inputTokens, result.outputTokens),
    wall_nanos: Number(process.hrtime.bigint() - start),
  };
}
