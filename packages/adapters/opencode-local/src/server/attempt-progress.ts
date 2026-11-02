/** Bounded, monotone evidence for retry decisions after a CLI failure.
 * Child-process stdout is tail-capped. Previously completed tools may no longer
 * appear in the retained final buffer; observe the full stream instead.
 * Never retain text, tool output, or credentials.
 */
export function createOpenCodeAttemptProgressGuard() {
  let remainder = "";
  let sawStream = false;
  let possibleWork = false;
  let starts = 0;
  let capacityErrors = 0;
  let otherErrors = 0;
  let sessionId: string | null = null;
  const MAX_LINE_CHARS = 128 * 1024;

  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

  const isCapacityError = (event: Record<string, unknown>) => {
    const error = record(event.error);
    const response = record(error.response);
    const data = record(error.data);
    let body: unknown = response.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const providerBody = record(body);
    const cause = record(providerBody.error);
    const code = cause.code ?? error.code ?? data.code;
    const status = error.status ?? response.status ?? data.status ?? cause.status;
    return code === "concurrency_limit" ||
      (status === 429 && (error.type === "provider.rate-limit" ||
        cause.type === "rate_limit_error" || code === "rate_limit_exceeded"));
  };

  const inspect = (raw: string) => {
    if (!raw.trim()) return;
    if (raw.length > MAX_LINE_CHARS) { possibleWork = true; return; }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { possibleWork = true; return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      possibleWork = true;
      return;
    }
    const event = value as Record<string, unknown>;
    if (typeof event.sessionID === "string" && event.sessionID.length > 0 &&
        event.sessionID.length <= 250) sessionId = event.sessionID;
    if (event.type === "step_start") {
      starts++;
      return;
    }
    if (event.type === "error") {
      if (isCapacityError(event)) capacityErrors++;
      else otherErrors++;
      return;
    }
    possibleWork = true;
  };

  const observe = (chunk: string) => {
    sawStream = true;
    if (possibleWork) return;
    const lines = (remainder + chunk).split(/\r?\n/);
    remainder = lines.pop() ?? "";
    for (const line of lines) inspect(line);
    if (remainder.length > MAX_LINE_CHARS) {
      possibleWork = true;
      remainder = "";
    }
  };

  const finalize = (fallbackStdout: string) => {
    if (!sawStream && fallbackStdout) observe(fallbackStdout);
    if (remainder) {
      inspect(remainder);
      remainder = "";
    }
  };

  return {
    observe,
    hasPossibleWork(finalStdout = ""): boolean {
      finalize(finalStdout);
      return possibleWork || starts > 0;
    },
    /** The only auto-retryable error is a single unambiguous provider refusal
     * before text, accounting or any tool event. A generic 429 string is not proof. */
    preInferenceCapacityRefusal(finalStdout = ""): boolean {
      finalize(finalStdout);
      return !possibleWork && starts === 1 && capacityErrors === 1 && otherErrors === 0;
    },
    observedSessionId(finalStdout = ""): string | null {
      finalize(finalStdout);
      return sessionId;
    },
  };
}
