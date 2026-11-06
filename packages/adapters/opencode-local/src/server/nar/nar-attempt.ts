// Opt-in NAR attempt for the OpenCode adapter (config nativeRuntime: "nar" + sharedServerRecoveryConfigPath).
// No child process: one deterministic session per agent+issue on the shared 2.2.5 server, one prompt with an op id
// derived from the run id (a restart first rejoins any in-flight message without resending), then
// poll provider evidence. Never retries submit. Spec: doc/spec/native-agent-runtime.md sections 2.3, 3, 10.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { OpenCodeHttpDriver, OpenCodeHttpError, messageIdFor, sessionIdFor } from "./opencode-http-driver.js";
import { parseOpenCodeJsonl } from "../parse.js";

export type NarAttempt = {
  proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
  rawStderr: string;
  parsed: ReturnType<typeof parseOpenCodeJsonl>;
  possibleWork: boolean;
  capacityRefusal: boolean;
  /** Merged into resultJson by execute.ts; absent on success. */
  executionRecovery?: { kind: "bootstrap"; providerWorkStarted: boolean; reason: string };
  /** Set when OpenCode itself proved the provider turn is gone (SCO-679); execute.ts acknowledges the cancellation. */
  providerTermination?: { proof: "server_restarted" | "session_idle"; reason: string };
};

export interface NarAttemptInput {
  configPath: string;
  agentId: string;
  taskId: string;
  runId: string;
  cwd: string;
  /** provider/model[#variant] */
  model: string;
  /** Session title, e.g. `SCO-12 Issue title`; absent => `Paperclip <issueId>`. */
  title?: string;
  /** Session Paperclip chose to resume; null/absent means it rotated (or this is the first wake). */
  resumeSessionId?: string | null;
  /** Re-entering an existing run must observe its own prompt only, never submit another. */
  reattachOnly?: boolean;
  /** A previously persisted exact binding, when the run had rejoined an older turn. */
  reattachBinding?: { sessionId: string; messageId: string; providerOrigin: string };
  invalidReattachBinding?: boolean;
  prompt: string;
  /** Check only new submissions; an in-flight recovery must remain observable. */
  preflight?: (sessionId?: string) => void | { rotate: boolean; prompt: string } | Promise<void | { rotate: boolean; prompt: string }>;
  timeoutSec: number;
  signal?: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** Persist the exact provider binding before submitting or observing a turn. */
  onBound?: (binding: { sessionId: string; messageId: string; kind: "submit" | "rejoin"; hostPid: number | null; providerOrigin: string }) => Promise<void>;
  pollMs?: number;
  /** Liveness probe cadence, idle-session grace, and unreachable-server give-up (SCO-679). */
  probeMs?: number;
  idleGraceMs?: number;
  unreachableGiveUpMs?: number;
  /** A rejoined in-flight message with no progress for this long is interrupted and the run ends (default 20 min). */
  rejoinStallMs?: number;
  fetchImpl?: typeof fetch;
}

export const narOpIdFor = (runId: string) => `nar-run-${runId}`;

// Machine-parseable run-log event: one `[paperclip:event] {json}` stdout line, so audits stop inferring
// rejoin vs fresh prompt from prose (SCO-495).
export const narEventLine = (event: "nar_rejoin" | "nar_prompt_dispatch", fields: Record<string, string>) =>
  `[paperclip:event] ${JSON.stringify({ event, ...fields })}\n`;

// run-control tags explicit Stop; shutdown/recovery uses an untagged abort so
// a persistent provider turn can survive and be rejoined without replay.
function explicitStopRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true && (signal.reason as { code?: unknown } | undefined)?.code === "paperclip_explicit_run_stop";
}

const emptyParsed = (sessionId: string | null, errorMessage: string | null): ReturnType<typeof parseOpenCodeJsonl> => ({
  sessionId, summary: "", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, peakContextTokens: 0 }, usageReported: false,
  usageComplete: false, costUsd: null, errorMessage, toolErrors: [], hasNonErrorOutput: false,
});

const held = (
  message: string, providerWorkStarted: boolean, sessionId: string | null, reason: string, extra?: Partial<NarAttempt["proc"]>,
): NarAttempt => ({
  proc: { exitCode: 75, signal: null, timedOut: false, stdout: "", stderr: message, ...extra },
  rawStderr: message,
  parsed: emptyParsed(sessionId, message),
  possibleWork: providerWorkStarted,
  capacityRefusal: false,
  executionRecovery: { kind: "bootstrap", providerWorkStarted, reason },
});

/** Provider turn is gone and verified from OpenCode: the session resumes, so replay is safe (SCO-679). */
const interrupted = (
  reason: string, proof: "server_restarted" | "session_idle", sessionId: string | null,
): NarAttempt => {
  const message = `OpenCode NAR ${reason}; provider termination verified (${proof})`;
  return {
    proc: { exitCode: 75, signal: null, timedOut: false, stdout: "", stderr: message },
    rawStderr: message,
    parsed: emptyParsed(sessionId, message),
    possibleWork: true,
    capacityRefusal: false,
    providerTermination: { proof, reason },
  };
};

/** A different active or queued message does not prove that this session is idle. */
async function verifyTermination(
  driver: OpenCodeHttpDriver, hostPid: number | null, conversationId: string, uncertainMessageId?: string,
): Promise<"server_restarted" | "session_idle" | null> {
  const pid = await driver.probePid();
  if (pid === null) return null;
  if (uncertainMessageId) return await driver.verifyStoppedMessage(conversationId, uncertainMessageId) ? "session_idle" : null;
  if (hostPid !== null && pid !== hostPid) return "server_restarted";
  try {
    return (await driver.inflightMessage(conversationId)) === null ? "session_idle" : null;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function readNarServer(configPath: string): Promise<{ url: string; passwordFile: string }> {
  if (!path.isAbsolute(configPath)) throw new Error("shared server config path must be absolute");
  const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  const url = cfg.url;
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}$/.test(url)) throw new Error("shared server url is not loopback");
  const passwordFile = typeof cfg.passwordFile === "string" && path.isAbsolute(cfg.passwordFile)
    ? cfg.passwordFile : path.join(path.dirname(configPath), "password");
  return { url, passwordFile };
}

/** A provider capacity refusal (llama-swap concurrency_limit): rate-limit error name, code or HTTP 429. */
export function isCapacityError(err: unknown): boolean {
  if (err == null) return false;
  let text: string;
  try { text = typeof err === "string" ? err : JSON.stringify(err); } catch { return false; }
  return /provider\.rate-limit|concurrency_limit|"(?:status|statusCode)"\s*:\s*"?429\b/i.test(text);
}

/** Typed cause of a failed OpenCode turn, from the structured error OpenCode records on the failed message/outcome. */
export function classifyOpenCodeError(err: unknown): { code: string; detail: string } | null {
  if (err == null) return null;
  const e: any = typeof err === "object" ? err : { message: String(err) };
  const type = typeof e.type === "string" ? e.type : "";
  const message = typeof e.message === "string" ? e.message : "";
  let text = "";
  try { text = JSON.stringify(err); } catch { text = message; }
  const detail = `${type || "error"}: ${message || text}`.replace(/\s+/g, " ").slice(0, 200);
  if (isCapacityError(err)) return { code: "opencode_provider_rate_limit", detail };
  if (/vision encoder/i.test(text)) return { code: "opencode_backend_vision_encoder_missing", detail };
  if (/variant unavailable/i.test(text) || type === "provider.no-route") return { code: "opencode_variant_unavailable", detail };
  if (/context[_ -]?(length|window|overflow)|too many tokens|maximum context/i.test(text) || /context-overflow/i.test(type)) return { code: "opencode_context_overflow", detail };
  if (/compaction/i.test(text)) return { code: "opencode_compaction_failed", detail };
  if (/^tool\./i.test(type)) return { code: "opencode_tool_error", detail };
  return { code: "opencode_session_failed", detail };
}

/** Read this op's usage from the session message log: messages created at/after our user message. */
async function collectOutcome(
  driverFetch: typeof fetch, url: string, passwordFile: string, sessionId: string, msgId: string, requireTarget = false,
): Promise<{ texts: string[]; usage: ReturnType<typeof parseOpenCodeJsonl>["usage"]; usageReported: boolean; costUsd: number | null; sessionOutcome: string | null; capacityRefusal: boolean; cause: { code: string; detail: string } | null }> {
  const pw = (await fs.readFile(passwordFile, "utf8")).trim();
  const headers = { authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64"), accept: "application/json" };
  const get = async (p: string) => {
    const r = await driverFetch(url + p, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (r.status !== 200) throw new Error(`GET ${p.split("?")[0]} HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  const sid = encodeURIComponent(sessionId);
  const list: any[] = (await get(`/api/session/${sid}/message?limit=200`))?.data ?? [];
  const mine = list.find((m) => m?.id === msgId);
  const created = mine?.time?.created;
  if (requireTarget && typeof created !== "number") throw new Error("recovered message absent from outcome window");
  const ops = typeof created === "number" ? list.filter((m) => m?.type === "assistant" && (m?.time?.created ?? 0) >= created) : [];
  ops.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, peakContextTokens: 0 };
  let usageReported = false;
  let cost: number | null = 0;
  const texts: string[] = [];
  for (const m of ops) {
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) texts.push(c.text.trim());
    }
    const t = m.tokens;
    const nums = [t?.input, t?.output, t?.cache?.read ?? 0, t?.cache?.write ?? 0, t?.reasoning ?? 0];
    if (nums.every((n) => Number.isSafeInteger(n) && n >= 0)) {
      usage.inputTokens += nums[0] + nums[3];
      usage.outputTokens += nums[1] + nums[4];
      usage.cachedInputTokens += nums[2];
      usage.peakContextTokens = Math.max(usage.peakContextTokens, nums[0] + nums[2] + nums[3]);
      usageReported = true;
    }
    if (typeof m.cost === "number" && Number.isFinite(m.cost) && m.cost >= 0) cost = (cost ?? 0) + m.cost;
    else cost = null;
  }
  let sessionOutcome: string | null = null;
  // llama-swap concurrency_limit surfaces as a provider.rate-limit / HTTP 429 error on the last op message or the session.
  // A later platform receipt or other trailing message must not hide the failed assistant message: use the last one carrying an error.
  const errored = [...ops].reverse().find((m) => m?.error != null || m?.finish === "error" || m?.finish?.type === "error");
  let capacityRefusal = errored != null && isCapacityError(errored.error ?? errored.finish ?? errored);
  // The failed outcome record (and the errored assistant message) carry the structured provider error.
  const outcomeRec = [...list].reverse().find((m) => m?.outcome === "failed" && m?.error != null && (m?.time?.created ?? 0) >= (created ?? 0));
  let cause = classifyOpenCodeError(outcomeRec?.error ?? errored?.error ?? null);
  try {
    const sess = (await get(`/api/session/${sid}`))?.data;
    cause ??= classifyOpenCodeError(sess?.error ?? sess?.outcome?.error ?? null);
    if (!capacityRefusal && !ops.some((m) => m?.content?.some?.((c: any) => c?.type === "text" && c.text?.trim()))) {
      capacityRefusal = isCapacityError(sess?.error) || isCapacityError(sess?.outcome?.error);
    }
    const o = sess?.outcome;
    sessionOutcome = typeof o === "string" ? o : typeof o?.type === "string" ? o.type : typeof o?.status === "string" ? o.status : null;
  } catch { /* outcome detail is advisory */ }
  return { texts, usage, usageReported, costUsd: ops.length ? cost : null, sessionOutcome, capacityRefusal: capacityRefusal || cause?.code === "opencode_provider_rate_limit", cause };
}

/**
 * One OpenCode session per agent+issue+generation. Paperclip resumes by passing back the id it saved; when it passes
 * none (first wake, or its session rotation cleared it) the pair moves to a fresh generation, so rotation really
 * drops OpenCode's accumulated context. A busy latest generation is still being worked by an earlier run of the
 * same pair (restart mid-run) and is rejoined, never abandoned.
 */
async function chooseSessionId(
  driver: OpenCodeHttpDriver, scope: { agentId: string; issueId: string }, resume: string | null | undefined, msgId: string,
): Promise<string> {
  const latest = await driver.latestGeneration(scope);
  if (resume) {
    for (let g = 0; g <= latest; g++) if (sessionIdFor(scope, g) === resume) return resume;
  }
  if (latest < 0) return sessionIdFor(scope, 0);
  const latestId = sessionIdFor(scope, latest);
  // A restart of the same run already has its prompt in the latest generation: stay there, never re-prompt elsewhere.
  if (await driver.messageExists(latestId, msgId) || await driver.inflightMessage(latestId)) return latestId;
  return sessionIdFor(scope, latest + 1);
}

export async function runNarOpenCodeAttempt(input: NarAttemptInput): Promise<NarAttempt> {
  const { onLog, signal } = input;
  if (input.reattachOnly && input.invalidReattachBinding)
    return held("OpenCode reattach binding is invalid; held without replay", true, null, "reattach_binding_invalid");
  if (signal?.aborted) return held("OpenCode NAR stopped before provider contact", Boolean(input.reattachOnly), null, "aborted_pre_submit");
  const f = input.fetchImpl ?? fetch;
  let server: { url: string; passwordFile: string };
  try {
    server = await readNarServer(input.configPath);
  } catch {
    await onLog("stderr", "[paperclip] NAR OpenCode server config unavailable; no inference sent.\n");
    return held("OpenCode NAR server config unavailable; no new inference sent", Boolean(input.reattachOnly), null, "config");
  }
  if (input.reattachBinding && input.reattachBinding.providerOrigin !== server.url)
    return held("OpenCode reattach provider endpoint changed; held without replay", true, null, "reattach_provider_mismatch");
  const driver = new OpenCodeHttpDriver({ url: server.url, passwordFile: server.passwordFile, fetchImpl: f });
  const opId = narOpIdFor(input.runId);
  const ownMessageId = messageIdFor(opId);
  let msgId = input.reattachBinding?.messageId ?? ownMessageId;
  let conversationId: string | null = null;
  let rejoined = false;
  let hostPid: number | null = null;
  let observedProviderWork = Boolean(input.reattachOnly);
  try {
    const host = await driver.attestHost(input.agentId);
    const hostDetail = host.detail as { pid?: unknown } | undefined;
    hostPid = Number.isInteger(hostDetail?.pid) ? Number(hostDetail?.pid) : null;
    const fence = { runId: input.runId, leaseGeneration: 1, hostEpoch: host.hostEpoch };
    const scope = { agentId: input.agentId, issueId: input.taskId };
    let targetSession: string;
    if (input.reattachOnly) {
      // Session rotation may have happened since the original dispatch. Find
      // this run's deterministic message, rather than adopting a successor.
      const latest = await driver.latestGeneration(scope);
      const matches: string[] = [];
      for (let g = 0; g <= latest; g++) {
        const candidate = sessionIdFor(scope, g);
        if (await driver.messageExists(candidate, msgId)) matches.push(candidate);
      }
      if (matches.length !== 1) return held("OpenCode reattach could not uniquely locate this run's message; held without replay", true, null, "reattach_message_unknown");
      if (input.reattachBinding && matches[0] !== input.reattachBinding.sessionId)
        return held("OpenCode reattach binding does not match its recorded session; held without replay", true, null, "reattach_binding_mismatch");
      targetSession = matches[0]!;
    } else targetSession = await chooseSessionId(driver, scope, input.resumeSessionId, msgId);
    const bound = await driver.bindConversation(
      host, { ...scope, cwd: input.cwd, model: input.model || undefined, title: input.title }, input.reattachOnly ? "resume" : "new", fence,
      targetSession,
    );
    conversationId = bound.conversationId;
    await onLog("stdout", `[paperclip] NAR OpenCode session ${conversationId} (run ${input.runId})\n`);
    // Rejoin: the conversation is per agent+issue, so a busy one is still working an earlier run's prompt
    // (e.g. Paperclip restarted mid-run). Settle on that message; never queue a second prompt behind it.
    const inflight = await driver.inflightMessage(conversationId);
    observedProviderWork ||= Boolean(inflight);
    if (input.reattachOnly && inflight && inflight !== msgId) {
      return held("OpenCode reattach found a different in-flight message; held without interrupting it", true, conversationId, "unowned_turn");
    }
    if (signal?.aborted) {
      // An old in-flight message may have been adopted during rejoin. Only a
      // deliberate Stop may interrupt it; an ordinary shutdown must leave it.
      if (inflight === ownMessageId && explicitStopRequested(signal)) {
        await driver.interruptExpectedMessage(conversationId, inflight,
          { opId: `${opId}-interrupt`, kind: "interrupt", payloadSha256: "" }, fence);
      }
      return held("OpenCode NAR stopped before sending a new prompt", Boolean(inflight) || Boolean(input.reattachOnly), conversationId, "aborted");
    }
    if (input.reattachOnly) {
      // A successor can already be active, or our message can have completed
      // while the controller was down. Observe only the original message.
      rejoined = true;
      await input.onBound?.({ sessionId: conversationId, messageId: msgId, kind: "rejoin", hostPid, providerOrigin: server.url });
      await onLog("stdout", narEventLine("nar_rejoin", { sessionId: conversationId, messageId: msgId }));
    } else if (inflight) {
      msgId = inflight;
      rejoined = true;
      await input.onBound?.({ sessionId: conversationId, messageId: msgId, kind: "rejoin", hostPid, providerOrigin: server.url });
      await onLog("stdout", `[paperclip] NAR rejoined in-flight message ${inflight}; prompt not resent\n`);
      await onLog("stdout", narEventLine("nar_rejoin", { sessionId: conversationId, messageId: inflight }));
    } else {
    const checked = await input.preflight?.(conversationId);
    if (checked) {
      input.prompt = checked.prompt;
      if (checked.rotate) {
        const freshId = await chooseSessionId(driver, scope, null, msgId);
        if (freshId === conversationId || await driver.inflightMessage(freshId))
          throw new Error("NAR input guard refused context rotation: conversation became busy");
        const fresh = await driver.bindConversation(host,
          { ...scope, cwd: input.cwd, model: input.model || undefined, title: input.title }, "new", fence, freshId);
        conversationId = fresh.conversationId;
      }
    }
    const payloadSha256 = createHash("sha256").update(input.prompt).digest("hex");
    await input.onBound?.({ sessionId: conversationId, messageId: msgId, kind: "submit", hostPid, providerOrigin: server.url });
    if (signal?.aborted) return held("OpenCode NAR stopped before sending a new prompt", false, conversationId, "aborted_pre_submit");
    await onLog("stdout", narEventLine("nar_prompt_dispatch", { sessionId: conversationId, clientMessageId: msgId, promptSha256: payloadSha256 }));
    observedProviderWork = true; // Submission can reach the provider even if its response is lost.
    const sub = await driver.submit(host, conversationId, { opId, kind: "prompt", payloadSha256, text: input.prompt }, fence);
    if (sub.grade === "outcome_unknown") {
      if (explicitStopRequested(signal)) {
        // A lost admission response does not authorize a resend. Best-effort
        // scoped interrupt only if this exact message is observed in flight.
        await driver.interruptExpectedMessage(conversationId, msgId,
          { opId: `${opId}-interrupt`, kind: "interrupt", payloadSha256: "" }, fence);
      }
      const m = `OpenCode NAR prompt outcome unknown (${sub.evidence.replace(/\s+/g, " ").slice(0, 200)}); held, not resent`;
      await onLog("stderr", `[paperclip] ${m}\n`);
      return held(m, true, conversationId, "submit_outcome_unknown");
    }
    }
  } catch (e) {
    const msg = e instanceof OpenCodeHttpError ? `${e.code}: ${e.message}` : (e as Error).message;
    // Before submit nothing was sent. A rejection (4xx) or auth failure is also pre-admission.
    const safe = `OpenCode NAR ${observedProviderWork ? "provider work unverified" : "attempt failed before inference"}: ${msg.slice(0, 300)}`;
    await onLog("stderr", `[paperclip] ${safe}\n`);
    return held(safe, observedProviderWork, conversationId, input.reattachOnly ? "reattach_unavailable" : "pre_submit");
  }

  const deadline = input.timeoutSec > 0 ? Date.now() + input.timeoutSec * 1000 : Infinity;
  const pollMs = input.pollMs ?? 5000;
  let settled = false;
  const probeMs = input.probeMs ?? 10000;
  const idleGraceMs = input.idleGraceMs ?? 30000;
  const unreachableGiveUpMs = input.unreachableGiveUpMs ?? 300000;
  let lastProbe = Date.now();
  let unreachableSince: number | null = null;
  let idleSince: number | null = null;
  const rejoinStallMs = input.rejoinStallMs ?? 20 * 60_000;
  let progressMark: string | null = null;
  let progressAt = Date.now();
  const loggedParts = new Map<string, string>();
  let loggedText = false;
  const logProgress = async () => {
    let messages: Awaited<ReturnType<OpenCodeHttpDriver["progressMessages"]>>;
    try { messages = await driver.progressMessages(conversationId, msgId); } catch { return; }
    for (const message of messages) {
      for (const [index, part] of message.content.entries()) {
        const key = `${message.id}:${index}`;
        if (part?.type === "text" && typeof part.text === "string") {
          const previous = loggedParts.get(key) ?? "";
          if (part.text !== previous) {
            const delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
            if (delta) { await onLog("stdout", delta); loggedText = true; }
            loggedParts.set(key, part.text);
          }
        } else if (part?.type === "tool" && typeof part.name === "string") {
          const status = typeof part.state?.status === "string" ? part.state.status : "started";
          const value = `${part.name}:${status}`;
          if (loggedParts.get(key) !== value) {
            await onLog("stdout", `\n[opencode] ${part.name}: ${status}\n`);
            loggedParts.set(key, value);
          }
        }
      }
    }
  };
  // A retry can observe a previous run's turn, but observing it does not
  // transfer authority to stop it. The deterministic message id is the
  // provider-side evidence that this run submitted the turn.
  const ownsMessage = msgId === ownMessageId;
  let interruptPromise: Promise<"requested" | "uncertain" | "idle"> | undefined;
  const interruptOnce = () => interruptPromise ??= ownsMessage ? driver.interruptExpectedMessage(
    conversationId, msgId,
    { opId: `${opId}-interrupt`, kind: "interrupt", payloadSha256: "" },
    { runId: input.runId, leaseGeneration: 1, hostEpoch: 0 },
  ) : Promise.resolve("uncertain");
  // Do not wait for a possibly slow outcome read to return before initiating
  // explicit Stop. Both this callback and the poll loop join the same request.
  const onAbort = () => { if (explicitStopRequested(signal)) void interruptOnce(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        if (explicitStopRequested(signal) && !ownsMessage) {
          return held("OpenCode NAR observed another run's turn; stop held without interrupting it", true, conversationId, "unowned_turn");
        }
        const interruptResult = explicitStopRequested(signal) ? await interruptOnce() : "rejoin";
        if (interruptResult !== "rejoin") {
          // Verify from OpenCode that the turn ended (session idle/absent, or the server restarted).
          for (let i = 0; i < 10; i++) {
            const proof = await verifyTermination(driver, hostPid, conversationId, msgId);
            if (proof) return interrupted("stopped by explicit Stop", proof, conversationId);
            await sleep(1500);
          }
        }
        const interrupted_ = interruptResult;
        const message = interrupted_ === "requested"
          ? "OpenCode NAR interrupt requested; provider termination is not yet proven"
          : interrupted_ === "idle"
            ? "OpenCode NAR stop found no matching in-flight message; no interrupt sent"
            : interrupted_ === "uncertain"
              ? "OpenCode NAR interrupt uncertain; held without replay"
              : "OpenCode NAR observer stopped; provider turn preserved for restart rejoin";
        return held(message, true, conversationId, interrupted_ === "uncertain" ? "interrupt_unknown" : "aborted");
      }
      const r = await driver.readOutcomeMsg(conversationId, msgId);
      await logProgress();
      // Stop may arrive while the outcome read is pending. Settle the Stop
      // request first rather than misreporting a concurrent read as success.
      if (signal?.aborted) continue;
      if (r === "hook_observed" || r === "receipted") { settled = true; break; }
      if (Date.now() >= deadline) break;
      // SCO-679: a dead server or a session left idle (e.g. compaction.interrupted) never settles on its own.
      if (Date.now() - lastProbe >= probeMs) {
        lastProbe = Date.now();
        const pid = await driver.probePid();
        if (pid === null) {
          unreachableSince ??= Date.now();
          if (Date.now() - unreachableSince >= unreachableGiveUpMs) {
            const m = "OpenCode NAR server unreachable; provider termination not verified";
            await onLog("stderr", `[paperclip] ${m}\n`);
            return held(m, true, conversationId, "server_unreachable");
          }
        } else {
          unreachableSince = null;
          if (hostPid !== null && pid !== hostPid) {
            const m = "OpenCode server identity changed; original provider termination is unverified";
            await onLog("stderr", `[paperclip] ${m}\n`);
            return held(m, true, conversationId, "server_identity_changed");
          }
          let inflight: string | null | undefined;
          try { inflight = await driver.inflightMessage(conversationId); } catch { inflight = undefined; }
          if (inflight !== null) idleSince = null;
          else {
            idleSince ??= Date.now();
            if (Date.now() - idleSince >= idleGraceMs) {
              const m = "OpenCode session idle without a verified outcome for the original message";
              await onLog("stderr", `[paperclip] ${m}\n`);
              return held(m, true, conversationId, "idle_outcome_unknown");
            }
          }
          // SCO-756: a rejoined message can stay in flight with nothing happening (run 2a483f33 sat 80 min on an idle
          // GPU). Bound it: no progress for rejoinStallMs interrupts that exact message so the next wake prompts afresh.
          if (rejoined && idleSince === null) {
            const mark = await driver.progressMark(conversationId);
            if (mark === null || mark !== progressMark) { if (mark !== null) progressMark = mark; progressAt = Date.now(); }
            else if (Date.now() - progressAt >= rejoinStallMs) {
              const mins = Math.round((Date.now() - progressAt) / 60_000);
              if (!ownsMessage) {
                const m = `OpenCode NAR observed another run's stalled turn for ${mins} min; held without interrupting it`;
                await onLog("stderr", `[paperclip] ${m}\n`);
                return held(m, true, conversationId, "unowned_turn_stalled");
              }
              await onLog("stderr", `[paperclip] NAR rejoined message ${msgId} made no progress for ${mins} min; requesting a safe stop\n`);
              await interruptOnce().catch(() => undefined);
              for (let i = 0; i < 10; i++) {
                const proof = await verifyTermination(driver, hostPid, conversationId, msgId);
                if (proof) return interrupted(`rejoined message stalled ${mins} min`, proof, conversationId);
                await sleep(1500);
              }
              const m = `OpenCode NAR rejoined message stalled ${mins} min; termination not verified`;
              await onLog("stderr", `[paperclip] ${m}\n`);
              return held(m, true, conversationId, "rejoin_stalled");
            }
          }
        }
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (!settled) {
    if (!ownsMessage) {
      return held("OpenCode NAR timed out observing another run's turn; held without interrupting it", true, conversationId, "unowned_turn_timeout", { timedOut: true });
    }
    await interruptOnce().catch(() => undefined);
    return {
      proc: { exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "" }, rawStderr: "",
      parsed: emptyParsed(conversationId, null), possibleWork: true, capacityRefusal: false,
    };
  }

  let out: Awaited<ReturnType<typeof collectOutcome>>;
  try {
    if (input.reattachOnly && await driver.hasSuccessor(conversationId, msgId))
      return held("OpenCode reattach found a successor in message history; outcome held", true, conversationId, "unowned_successor");
    out = await collectOutcome(f, server.url, server.passwordFile, conversationId, msgId, Boolean(input.reattachOnly));
    if (input.reattachOnly && await driver.hasSuccessor(conversationId, msgId))
      return held("OpenCode reattach found a successor while reading the outcome; outcome held", true, conversationId, "unowned_successor");
  } catch {
    if (input.reattachOnly) return held("OpenCode reattach outcome could not be verified; held without replay", true, conversationId, "reattach_outcome_unknown");
    out = { texts: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, peakContextTokens: 0 }, usageReported: false, costUsd: null, sessionOutcome: null, capacityRefusal: false, cause: null };
  }
  const summary = out.texts.join("\n\n");
  if (summary && !loggedText) await onLog("stdout", summary + "\n");
  const failed = out.sessionOutcome !== null && /fail|error|interrupt|abort|cancel/i.test(out.sessionOutcome);
  const refused = failed && out.capacityRefusal;
  const cause = failed ? (out.cause ?? { code: "opencode_session_failed", detail: "no error recorded on the session" }) : null;
  const errorMessage = failed ? `OpenCode session outcome: ${out.sessionOutcome} [${cause!.code}] ${cause!.detail}` : null;
  const parsed = emptyParsed(conversationId, errorMessage);
  parsed.summary = summary;
  parsed.usage = out.usage;
  parsed.usageReported = out.usageReported;
  parsed.usageComplete = out.usageReported && out.costUsd !== null;
  parsed.costUsd = out.costUsd;
  parsed.hasNonErrorOutput = true;
  return {
    proc: { exitCode: failed ? 1 : 0, signal: null, timedOut: false, stdout: summary, stderr: errorMessage ?? "", errorCode: cause?.code ?? null },
    rawStderr: errorMessage ?? "",
    parsed,
    possibleWork: true,
    capacityRefusal: refused,
  };
}
