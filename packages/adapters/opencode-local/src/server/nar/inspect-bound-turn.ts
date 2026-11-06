import { MAX_SESSION_GENERATION, messageIdFor, OpenCodeHttpDriver, sessionIdFor } from "./opencode-http-driver.js";
import { narOpIdFor, readNarServer } from "./nar-attempt.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

/** Read-only evidence for an operator, not authority to stop or finalize a run.
 * PID equality does not establish process birth, and an external client may
 * submit immediately after this observation. Callers must separately fence
 * ownership, submission, workspace obligations and terminalization. */
export async function inspectBoundOpenCodeTurn(input: {
  runId: string; agentId: string; taskId: string; cwd: string; configPath: string;
  earlySession: unknown; fetchImpl?: typeof fetch;
}): Promise<{ state: "observed_idle" | "unverified"; reason: string }> {
  const unknown = (reason: string) => ({ state: "unverified" as const, reason });
  const session = object(input.earlySession), params = object(session.sessionParams), binding = object(params.narBinding);
  if (![input.runId, input.agentId, input.taskId, input.cwd, input.configPath].every(value => typeof value === "string" && value.length > 0) ||
      binding.schema !== "paperclip.opencode-binding.v1" || binding.runId !== input.runId ||
      binding.agentId !== input.agentId || binding.taskId !== input.taskId || binding.kind !== "submit" ||
      binding.configPath !== input.configPath || params.cwd !== input.cwd ||
      typeof session.sessionId !== "string" || session.sessionId !== params.sessionId ||
      binding.messageId !== messageIdFor(narOpIdFor(input.runId)) ||
      !Number.isSafeInteger(binding.hostPid) || Number(binding.hostPid) <= 0 || typeof binding.providerOrigin !== "string") {
    return unknown("binding_invalid_or_unowned");
  }
  const scope = { agentId: input.agentId, issueId: input.taskId };
  if (!Array.from({ length: MAX_SESSION_GENERATION + 1 }, (_, generation) => sessionIdFor(scope, generation)).includes(session.sessionId))
    return unknown("session_not_in_scope");
  try {
    const server = await readNarServer(input.configPath);
    if (server.url !== binding.providerOrigin) return unknown("provider_changed");
    const deadline = AbortSignal.timeout(10_000);
    const fetchImpl = input.fetchImpl ?? fetch;
    const boundedFetch: typeof fetch = (url, init) => fetchImpl(url, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
    const driver = new OpenCodeHttpDriver({ url: server.url, passwordFile: server.passwordFile,
      expectedPid: Number(binding.hostPid), fetchImpl: boundedFetch, timeoutMs: 2_000 });
    await driver.attestHost(input.agentId);
    if (!await driver.sessionMatches(session.sessionId, input.cwd)) return unknown("session_mismatch");
    if (!await driver.verifyStoppedMessage(session.sessionId, binding.messageId as string)) return unknown("target_not_verified_idle");
    if (!await driver.sessionMatches(session.sessionId, input.cwd)) return unknown("session_mismatch");
    await driver.attestHost(input.agentId);
    const latestServer = await readNarServer(input.configPath);
    if (latestServer.url !== server.url || latestServer.passwordFile !== server.passwordFile) return unknown("provider_changed");
    return { state: "observed_idle", reason: "target_idle_at_observation" };
  } catch {
    return unknown("provider_unavailable_or_changed");
  }
}
