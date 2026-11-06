import { createHash, randomUUID } from "node:crypto";

/** Opt-in for a private, single-session provider proxy. Memory only: proxy- or
 * runner-process restart loses the held request and invalidates the checkpoint.
 * This only gates inference-server restart while the owner processes stay alive;
 * durable proxy/runner recovery and KV slot save/restore are not implemented. */
export class OpenCodeProviderBoundary {
  #active = 0;
  #closed = false;
  #cleanup: (() => void) | null = null;
  #pending: { resolve: (value: { id: string; requestSha256: string }) => void; reject: (error: Error) => void } | null = null;
  #held: { id: string; requestSha256: string; release: () => void; reject: (error: Error) => void } | null = null;

  freeze(options: { timeoutMs: number; signal: AbortSignal }): Promise<{ id: string; requestSha256: string }> {
    if (this.#closed || this.#pending || this.#held) throw new Error("provider_boundary_unavailable");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error("provider_boundary_invalid_deadline");
    options.signal.throwIfAborted();
    const cancel = () => this.#terminate(new Error("provider_boundary_cancelled"));
    const timer = setTimeout(() => this.#terminate(new Error("provider_boundary_deadline")), options.timeoutMs);
    options.signal.addEventListener("abort", cancel, { once: true });
    this.#cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); };
    return new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
  }

  resume(checkpoint: { id: string; requestSha256: string }): void {
    if (!this.#held || this.#held.id !== checkpoint.id || this.#held.requestSha256 !== checkpoint.requestSha256) throw new Error("provider_boundary_checkpoint_mismatch");
    const held = this.#held;
    this.#held = null;
    this.#cleanup?.(); this.#cleanup = null;
    held.release();
  }

  close(): void {
    this.#terminate(new Error("provider_boundary_closed"));
  }

  #terminate(error: Error): void {
    this.#closed = true;
    this.#cleanup?.(); this.#cleanup = null;
    this.#pending?.reject(error);
    this.#pending = null;
    this.#held?.reject(error);
    this.#held = null;
  }

  async enter(body: Buffer, payload: Record<string, unknown>, signal: AbortSignal): Promise<() => void> {
    if (this.#closed || this.#held) throw new Error("provider_boundary_concurrent_or_closed");
    let acquired = false;
    try {
      signal.throwIfAborted();
      if (this.#pending && isToolBoundary(payload)) {
        if (this.#active !== 0) {
          this.#terminate(new Error("provider_boundary_concurrent"));
          throw new Error("provider_boundary_concurrent");
        }
        this.#active++;
        acquired = true;
        const pending = this.#pending;
        this.#pending = null;
        const id = randomUUID();
        const requestSha256 = createHash("sha256").update(body).digest("hex");
        const wait = new Promise<void>((release, reject) => { this.#held = { id, requestSha256, release, reject }; });
        const abort = () => {
          if (this.#held?.id === id) this.#terminate(new Error("provider_boundary_request_lost"));
          // Reject even if resume and disconnect race; the HTTP layer also
          // passes this signal to the upstream request.
          rejectWait(new Error("provider_boundary_request_lost"));
        };
        let rejectWait!: (error: Error) => void;
        const aborted = new Promise<never>((_, reject) => { rejectWait = reject; });
        signal.addEventListener("abort", abort, { once: true });
        pending.resolve({ id, requestSha256 });
        try { await Promise.race([wait, aborted]); signal.throwIfAborted(); }
        finally { signal.removeEventListener("abort", abort); }
        return () => { this.#active--; };
      }
      this.#active++;
      acquired = true;
      return () => { this.#active--; };
    } catch (error) { if (acquired) this.#active--; throw error; }
  }
}

function isToolBoundary(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.messages)) return false;
  const messages = payload.messages as Array<Record<string, unknown>>;
  let index = messages.length - 1;
  const results = new Set<string>();
  while (index >= 0 && messages[index]?.role === "tool") {
    const id = messages[index]?.tool_call_id;
    if (typeof id !== "string" || !id || results.has(id)) return false;
    results.add(id);
    index--;
  }
  const assistant = messages[index];
  if (!results.size || !assistant || assistant.role !== "assistant" || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length !== results.size) return false;
  const calls = new Set<string>();
  for (const call of assistant.tool_calls) {
    if (!call || typeof call !== "object" || typeof call.id !== "string" || !results.has(call.id) || calls.has(call.id)) return false;
    calls.add(call.id);
  }
  return true;
}
