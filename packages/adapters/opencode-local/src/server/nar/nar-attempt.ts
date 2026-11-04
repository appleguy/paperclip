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
  prompt: string;
  timeoutSec: number;
  signal?: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export const narOpIdFor = (runId: string) => `nar-run-${runId}`;

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function readServer(configPath: string): Promise<{ url: string; passwordFile: string }> {
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

/** Read this op's usage from the session message log: messages created at/after our user message. */
async function collectOutcome(
  driverFetch: typeof fetch, url: string, passwordFile: string, sessionId: string, msgId: string,
): Promise<{ texts: string[]; usage: ReturnType<typeof parseOpenCodeJsonl>["usage"]; usageReported: boolean; costUsd: number | null; sessionOutcome: string | null; capacityRefusal: boolean }> {
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
  let capacityRefusal = ops.length > 0 && isCapacityError(ops[ops.length - 1]?.error);
  try {
    const sess = (await get(`/api/session/${sid}`))?.data;
    if (!capacityRefusal && !ops.some((m) => m?.content?.some?.((c: any) => c?.type === "text" && c.text?.trim()))) {
      capacityRefusal = isCapacityError(sess?.error) || isCapacityError(sess?.outcome?.error);
    }
    const o = sess?.outcome;
    sessionOutcome = typeof o === "string" ? o : typeof o?.type === "string" ? o.type : typeof o?.status === "string" ? o.status : null;
  } catch { /* outcome detail is advisory */ }
  return { texts, usage, usageReported, costUsd: ops.length ? cost : null, sessionOutcome, capacityRefusal };
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
  if (signal?.aborted) return held("OpenCode NAR stopped before provider contact", false, null, "aborted_pre_submit");
  const f = input.fetchImpl ?? fetch;
  let server: { url: string; passwordFile: string };
  try {
    server = await readServer(input.configPath);
  } catch {
    await onLog("stderr", "[paperclip] NAR OpenCode server config unavailable; no inference sent.\n");
    return held("OpenCode NAR server config unavailable; no inference sent", false, null, "config");
  }
  const driver = new OpenCodeHttpDriver({ url: server.url, passwordFile: server.passwordFile, fetchImpl: f });
  const opId = narOpIdFor(input.runId);
  let msgId = messageIdFor(opId);
  let conversationId: string | null = null;
  try {
    const host = await driver.attestHost(input.agentId);
    const fence = { runId: input.runId, leaseGeneration: 1, hostEpoch: host.hostEpoch };
    const scope = { agentId: input.agentId, issueId: input.taskId };
    const bound = await driver.bindConversation(
      host, { ...scope, cwd: input.cwd, model: input.model || undefined, title: input.title }, "new", fence,
      await chooseSessionId(driver, scope, input.resumeSessionId, msgId),
    );
    conversationId = bound.conversationId;
    await onLog("stdout", `[paperclip] NAR OpenCode session ${conversationId} (run ${input.runId})\n`);
    // Rejoin: the conversation is per agent+issue, so a busy one is still working an earlier run's prompt
    // (e.g. Paperclip restarted mid-run). Settle on that message; never queue a second prompt behind it.
    const inflight = await driver.inflightMessage(conversationId);
    if (signal?.aborted) {
      // An old in-flight message may have been adopted during rejoin. Only a
      // deliberate Stop may interrupt it; an ordinary shutdown must leave it.
      if (inflight && explicitStopRequested(signal)) {
        await driver.interruptExpectedMessage(conversationId, inflight,
          { opId: `${opId}-interrupt`, kind: "interrupt", payloadSha256: "" }, fence);
      }
      return held("OpenCode NAR stopped before sending a new prompt", Boolean(inflight), conversationId, "aborted");
    }
    if (inflight) {
      msgId = inflight;
      await onLog("stdout", `[paperclip] NAR rejoined in-flight message ${inflight}; prompt not resent\n`);
    } else {
    const payloadSha256 = createHash("sha256").update(input.prompt).digest("hex");
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
    const safe = `OpenCode NAR attempt failed before inference: ${msg.slice(0, 300)}`;
    await onLog("stderr", `[paperclip] ${safe}\n`);
    return held(safe, false, conversationId, "pre_submit");
  }

  const deadline = input.timeoutSec > 0 ? Date.now() + input.timeoutSec * 1000 : Infinity;
  const pollMs = input.pollMs ?? 5000;
  let settled = false;
  let interruptPromise: Promise<"requested" | "uncertain" | "idle"> | undefined;
  const interruptOnce = () => interruptPromise ??= driver.interruptExpectedMessage(
    conversationId, msgId,
    { opId: `${opId}-interrupt`, kind: "interrupt", payloadSha256: "" },
    { runId: input.runId, leaseGeneration: 1, hostEpoch: 0 },
  );
  // Do not wait for a possibly slow outcome read to return before initiating
  // explicit Stop. Both this callback and the poll loop join the same request.
  const onAbort = () => { if (explicitStopRequested(signal)) void interruptOnce(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        const interrupted = explicitStopRequested(signal) ? await interruptOnce() : "rejoin";
        const message = interrupted === "requested"
          ? "OpenCode NAR interrupt requested; provider termination is not yet proven"
          : interrupted === "idle"
            ? "OpenCode NAR stop found no matching in-flight message; no interrupt sent"
            : interrupted === "uncertain"
              ? "OpenCode NAR interrupt uncertain; held without replay"
              : "OpenCode NAR observer stopped; provider turn preserved for restart rejoin";
        return held(message, true, conversationId, interrupted === "uncertain" ? "interrupt_unknown" : "aborted");
      }
      const r = await driver.readOutcomeMsg(conversationId, msgId);
      // Stop may arrive while the outcome read is pending. Settle the Stop
      // request first rather than misreporting a concurrent read as success.
      if (signal?.aborted) continue;
      if (r === "hook_observed" || r === "receipted") { settled = true; break; }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (!settled) {
    await interruptOnce().catch(() => undefined);
    return {
      proc: { exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "" }, rawStderr: "",
      parsed: emptyParsed(conversationId, null), possibleWork: true, capacityRefusal: false,
    };
  }

  let out: Awaited<ReturnType<typeof collectOutcome>>;
  try {
    out = await collectOutcome(f, server.url, server.passwordFile, conversationId, msgId);
  } catch {
    out = { texts: [], usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, peakContextTokens: 0 }, usageReported: false, costUsd: null, sessionOutcome: null, capacityRefusal: false };
  }
  const summary = out.texts.join("\n\n");
  if (summary) await onLog("stdout", summary + "\n");
  const failed = out.sessionOutcome !== null && /fail|error|interrupt|abort|cancel/i.test(out.sessionOutcome);
  const refused = failed && out.capacityRefusal;
  const errorMessage = failed ? `OpenCode session outcome: ${out.sessionOutcome}` : null;
  const parsed = emptyParsed(conversationId, errorMessage);
  parsed.summary = summary;
  parsed.usage = out.usage;
  parsed.usageReported = out.usageReported;
  parsed.usageComplete = out.usageReported && out.costUsd !== null;
  parsed.costUsd = out.costUsd;
  parsed.hasNonErrorOutput = true;
  return {
    proc: { exitCode: failed ? 1 : 0, signal: null, timedOut: false, stdout: summary, stderr: errorMessage ?? "" },
    rawStderr: errorMessage ?? "",
    parsed,
    possibleWork: true,
    capacityRefusal: refused,
  };
}
