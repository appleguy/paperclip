import { executionFailureRetryCount } from "./execution-recovery-attempt.js";

/** Wrapper exit 75 is safe to re-admit only for these exact pre-inference declines. */
type Candidate = {
  errorCode?: string | null;
  exitCode?: number | null;
  error?: string | null;
  runnerProfileJson?: unknown;
  scheduledRetryReason?: string | null;
  scheduledRetryAttempt?: number | null;
  contextSnapshot?: Record<string, unknown> | null;
};

export const LOCAL_OPENCODE_ADMISSION_RETRY_DELAYS_MS = [
  60_000, 90_000, 150_000, 240_000, 360_000, 600_000,
] as const;

export function isLocalOpenCodeAdmissionDecline(run: Candidate): boolean {
  if (run.errorCode !== "adapter_failed" || run.exitCode !== 75) return false;
  const profile = run.runnerProfileJson;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const dispatch = (profile as Record<string, unknown>).adapterDispatch;
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch) ||
      (dispatch as Record<string, unknown>).adapterType !== "opencode_local") return false;
  const firstLine = (run.error ?? "").split("\n", 1)[0]!.trim();
  return (
    /^WRX80 admission declined \(BUSY:(?:GPU|external-engine|other-model-or-loading)\); no inference sent$/.test(firstLine) ||
    firstLine === "Maya Paperclip host/model already owned; no inference sent" ||
    firstLine === "Mac Maya already serving another Paperclip run; no second request" ||
    firstLine === "Mac Pro Maya-L admission refused: Model not advertised"
  );
}

/** Six bounded attempts within 30 minutes; don't consume capacity on a busy host. */
export function localOpenCodeAdmissionRetryOptions(run: Candidate, random: () => number = Math.random) {
  if (!isLocalOpenCodeAdmissionDecline(run)) return null;
  const attempt = executionFailureRetryCount(run) + 1;
  const baseMs = LOCAL_OPENCODE_ADMISSION_RETRY_DELAYS_MS[attempt - 1] ?? 0;
  const jitter = Math.min(1, Math.max(0, random()));
  return {
    maxAttempts: LOCAL_OPENCODE_ADMISSION_RETRY_DELAYS_MS.length,
    delayMs: baseMs + Math.floor(baseMs * 0.1 * jitter),
  };
}
