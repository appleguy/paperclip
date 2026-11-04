/**
 * Paperclip -> one long-lived Antigravity TUI Remote Control instance.
 * agy 1.4.x has no supported daemon injection protocol; the tmux pane is
 * the *same* interactive process users see and steer at the stable /r/ URL.
 * Deliberately serialized, fail-closed on ambiguous completion/recovery.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections, renderTemplate, selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";

const runFile = promisify(execFile);
const AGY = "/opt/homebrew/bin/agy";
const DEFAULT_MODEL = "gemini-3.8-flash-low";
const MODEL_FAMILIES: Record<string, string> = {
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
};
export const AGY_MODELS = [
  "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
  "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high",
  "claude-opus-5-5-medium", "claude-opus-5-5-high",
  "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high",
] as const;
/** Gemini 3.8 Flash, Gemini 4 Argon and Claude Opus/Sonnet 5.5 (Antigravity 3p pool) tiers run here; GPT and any other model are refused. */
export function resolveAgyModel(value: unknown): string {
  const model = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MODEL;
  if (!(AGY_MODELS as readonly string[]).includes(model))
    throw new Error(`agy adapter permits only ${AGY_MODELS.join(", ")}; received ${model}`);
  return model;
}
function modelLabel(model: string): string {
  const i = model.lastIndexOf("-");
  const tier = model.slice(i + 1);
  return `${MODEL_FAMILIES[model.slice(0, i)] ?? model} ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}
const ID = /^[a-zA-Z0-9_-]{1,55}$/;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
export function normalizeOneLine(value: string): string {
  // tmux paste-buffer with embedded newlines submits partial TUI prompts.
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
export function pasteSettleMs(charCount: number): number {
  return Math.min(3000, Math.max(350, 500 + Math.ceil(charCount / 1500) * 300));
}
export function parseRemoteUrl(screen: string): string | null {
  return screen.match(/https:\/\/antigravity\.google\.com\/r\/[a-zA-Z0-9-]+/)?.[0] ?? null;
}
export function parseRemoteConversationId(screen: string): string | null {
  // /remote-control prints the live ID before the first prompt, unlike the stale cache.
  // agy hard-wraps long URLs onto an indented next line (capture-pane -J cannot rejoin those),
  // so match on a copy with line breaks and their indentation removed. The 36-char UUID bound
  // keeps the join from absorbing following words.
  const compact = screen.replace(/[ \t]*\r?\n[ \t│┃]*/g, "");
  const ids = [...compact.matchAll(/p=c%2F([a-f0-9-]{36})/gi)];
  return ids.length ? ids[ids.length - 1]![1] : null;
}
/**
 * Match the *current* editor between its two border rules, not a historical
 * empty ">" in the transcript. Works with both stock and custom status lines.
 * A wrapped/half-composed prompt fails closed.
 */
export function isEmptyInputBox(screen: string): boolean {
  const lines = screen.replace(/\r/g, "").trimEnd().split("\n").slice(-35);
  const borders = lines.flatMap((line, i) => /^\s*[─━═]{6,}\s*$/.test(line) ? [i] : []);
  if (borders.length < 2) return false;
  const bottom = borders[borders.length - 1]!;
  const top = borders[borders.length - 2]!;
  if (lines.length - bottom > 10) return false;
  const editor = lines.slice(top + 1, bottom).filter(line => line.trim() !== "");
  if (editor.length !== 1 || !/^\s*>\s*$/.test(editor[0]!)) return false;
  return !/esc to cancel|Generating\.\.\.|Working\.\.\./i.test(lines.slice(top).join("\n"));
}

export function isIdleScreen(screen: string): boolean {
  return isEmptyInputBox(screen);
}

export type AgyStatusLineSnapshot = {
  schemaVersion: 1;
  agentState: string;
  observedAt: string;
  idleSince: string | null;
  cwd: string;
  conversationId: string | null;
  pendingInputCount: number;
  toolConfirmationPending: boolean;
};

/**
 * Advisory two-source check: only a verified idle status plus an empty input
 * editor permits pane input. Status-line callbacks are event-driven, not
 * heartbeats; a stale status can qualify once it has been idle for >=5min.
 */
export function inputGuard(
  screen: string, snapshot: unknown, expectedCwd: string,
  now = Date.now(), expectedConversationId?: string | null,
): { allowed: boolean; reason: string } {
  const refuse = (reason: string) => ({ allowed: false, reason });
  if (!isEmptyInputBox(screen)) return refuse("TUI input is nonempty, busy, or not recognizable");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return refuse("agy statusLine snapshot missing");
  const s = snapshot as Partial<AgyStatusLineSnapshot>;
  if (s.schemaVersion !== 1 || s.agentState !== "idle")
    return refuse("agy statusLine is not idle");
  if (s.cwd !== expectedCwd) return refuse("agy statusLine workspace mismatch");
  if (expectedConversationId && s.conversationId !== expectedConversationId)
    return refuse("agy statusLine conversation mismatch");
  if (s.toolConfirmationPending === true || typeof s.pendingInputCount !== "number"
      || s.pendingInputCount !== 0)
    return refuse("agy has pending input or confirmation");
  const observed = Date.parse(s.observedAt ?? "");
  const idleSince = Date.parse(s.idleSince ?? "");
  if (!Number.isFinite(observed) || !Number.isFinite(idleSince)
      || observed > now + 2000 || idleSince > observed || observed < 0)
    return refuse("agy idle timestamps invalid");
  const fresh = now - observed <= 15_000;
  const longIdle = now - idleSince >= 300_000;
  if (fresh || longIdle)
    return { allowed: true, reason: fresh ? "current idle + empty input" : "idle >=5min + empty input" };
  // agy rewrites its statusLine only on state changes, so right after a turn the idle
  // snapshot is stale. Owner amendment 1 permits typing when the input is empty; the
  // caller must confirm the empty editor is stable across two captures (STALE_IDLE).
  return { allowed: true, reason: STALE_IDLE };
}
export const STALE_IDLE = "idle statusLine (stale) + empty input; stable-screen check required";
export type Receipt = { runId: string; issueId: string; status: string; summary: string; report: string };
export function parseReceipt(raw: string, runId: string, issueId: string): Receipt {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid agy receipt object");
  const r = parsed as Record<string, unknown>;
  if (r.runId !== runId || r.issueId !== issueId || r.status !== "done"
      || typeof r.summary !== "string" || r.summary.trim().length < 8
      || typeof r.report !== "string" || r.report.trim().length < 250) {
    throw new Error("agy receipt missing exact run/issue ID, done state, summary, or report >=250 characters");
  }
  return r as Receipt;
}
export type ActiveDispatch = { runId: string; issueId: string; receiptPath: string; rcUrl: string; conversationId?: string | null };
/**
 * Crash reconciliation without replay: a checkpoint for the SAME issue is
 * adopted by the next run (the TUI kept working while Paperclip restarted);
 * a checkpoint for any other issue still refuses dispatch.
 */
export function adoptableActive(raw: string, issueId: string, stateDir: string, adapter = "agy"): ActiveDispatch | null {
  if (!raw) return null;
  let a: Partial<ActiveDispatch>;
  try { a = JSON.parse(raw) as Partial<ActiveDispatch>; } catch { a = {}; }
  const expectedReceipt = typeof a.runId === "string" ? path.join(stateDir, `receipt-${a.runId}.json`) : "";
  if (a.issueId !== issueId || typeof a.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(a.runId)
      || a.receiptPath !== expectedReceipt || typeof a.rcUrl !== "string") {
    throw new Error(`${adapter} previous task unresolved; inspect active.json and its receipt before dispatch. Never replay actions`);
  }
  return a as ActiveDispatch;
}

export async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await runFile("/opt/homebrew/bin/tmux", ["-L", socket, ...args], {
    timeout: 10_000, maxBuffer: 2_000_000,
  });
  return stdout;
}
const target = (session: string) => ["-t", session];
export async function pane(socket: string, session: string): Promise<string> {
  return tmux(socket, ["capture-pane", ...target(session), "-p", "-J", "-S", "-150"]);
}
async function inputReadiness(
  socket: string, session: string, stateDir: string, cwd: string,
  expectedConversationId?: string | null,
): Promise<{ allowed: boolean; reason: string }> {
  let snapshot: unknown = null;
  try { snapshot = JSON.parse(await fs.readFile(path.join(stateDir, "status-line.json"), "utf8")); }
  catch { /* Missing/unreadable statusLine is NOT proof that agy is idle. */ }
  const screen = await pane(socket, session);
  const verdict = inputGuard(screen, snapshot, cwd, Date.now(), expectedConversationId);
  if (!verdict.allowed || verdict.reason !== STALE_IDLE) return verdict;
  // Stale idle snapshot: require the same empty, non-busy screen 1.5s later
  // (no owner keystrokes, no new turn rendering) before any pane input.
  await sleep(1500);
  return (await pane(socket, session)) === screen
    ? verdict
    : { allowed: false, reason: "agy screen changed during stale-idle stability check" };
}

export async function send(
  socket: string, session: string, message: string, stateDir: string, cwd: string,
  expectedConversationId?: string | null,
): Promise<void> {
  if (/[\r\n]/.test(message)) throw new Error("multiline TUI submissions forbidden");
  const readiness = await inputReadiness(socket, session, stateDir, cwd, expectedConversationId);
  if (!readiness.allowed) throw new Error(`agy input guard refused: ${readiness.reason}`);
  await pasteSubmit(socket, session, message, stateDir);
}

/** One-line bracketed paste + Enter. Callers own their input guard (agy: send(); claude-rc: its own idle check). */
export async function pasteSubmit(socket: string, session: string, message: string, stateDir: string): Promise<void> {
  if (/[\r\n]/.test(message)) throw new Error("multiline TUI submissions forbidden");
  // Private UTF-8 file and named tmux buffer: no prompt in argv, no shared
  // unnamed paste buffer. Bracketed paste keeps '/' and text inside one edit.
  const file = path.join(stateDir, "dispatch-input.txt");
  const buffer = `paperclip-agy-${process.pid}-${session}`;
  await fs.writeFile(file, message, { mode: 0o600 });
  try {
    await tmux(socket, ["load-buffer", "-b", buffer, file]);
    await tmux(socket, ["paste-buffer", "-p", "-r", "-d", "-b", buffer, ...target(session)]);
    // agy 1.4.x processes long bracketed-paste input asynchronously. Sending
    // Enter immediately can leave the entire issue prompt in its editor.
    await sleep(pasteSettleMs(message.length));
    await tmux(socket, ["send-keys", ...target(session), "Enter"]);
  } finally {
    // paste-buffer -d normally deletes this; also clean up failed pastes.
    await tmux(socket, ["delete-buffer", "-b", buffer]).catch(() => {});
    await fs.rm(file, { force: true });
  }
}

async function waitIdle(
  socket: string, session: string, stateDir: string, cwd: string, deadline: number,
  expectedConversationId?: string | null,
): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      if ((await inputReadiness(socket, session, stateDir, cwd, expectedConversationId)).allowed) return true;
    } catch { return false; }
    await sleep(900);
  }
  return false;
}

async function inspectRemoteConversation(
  socket: string, session: string, stateDir: string, cwd: string,
): Promise<{ url: string; id: string }> {
  await send(socket, session, "/remote-control", stateDir, cwd);
  await sleep(500);
  if (!(await waitIdle(socket, session, stateDir, cwd, Date.now() + 12_000)))
    throw new Error("agy /remote-control did not return to idle");
  const screen = await pane(socket, session);
  const url = parseRemoteUrl(screen);
  const id = parseRemoteConversationId(screen);
  if (!url || !id) throw new Error("agy /remote-control did not expose the instance URL and conversation ID");
  return { url, id };
}

const AGENT_TMP_ROOT = "/Volumes/NVM/AI_Agent_Runtime/tmp";
function agentTmpDir(session: string): string { return path.join(AGENT_TMP_ROOT, `agy-${session}`); }

/** SCO-534: never run from / or system temp. The default hidden ~/.paperclip cwd stays until the live session is re-pinned. */
function assertWorkableCwd(cwd: string): void {
  if (cwd === "/" || cwd.startsWith("/private/var/folders") || cwd.startsWith("/var/folders"))
    throw new Error(`agy cwd ${cwd} is root or system temp; use a canonical NVM path (SCO-534)`);
}

async function ensureSession(
  socket: string, session: string, cwd: string, stateDir: string, rejoinOnly: boolean, model: string,
): Promise<string> {
  let exists = true;
  try { await tmux(socket, ["has-session", ...target(session)]); } catch { exists = false; }
  if (!exists) {
    // An already-emitted op cannot be rejoined through a newly launched TUI.
    if (rejoinOnly) throw new Error("agy active op lost its original TUI; operator reconciliation required, never replay");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(agentTmpDir(session), { recursive: true });
    // tmux exec mode: no interpolated shell source or arbitrary model selection.
    await tmux(socket, ["new-session", "-d", "-s", session, "-c", cwd,
      "-e", `TMPDIR=${agentTmpDir(session)}`,
      AGY, "--remote-control", "--dangerously-skip-permissions", "--model", model]);
  }
  const processName = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_command}"])).trim();
  if (processName !== "agy") throw new Error(`tmux pane is ${processName}, not agy; refusing to commandeer it`);
  if (!rejoinOnly && !(await waitIdle(socket, session, stateDir, cwd, Date.now() + 20_000))) {
    const s = await pane(socket, session);
    if (/Do you trust the contents/.test(s)) {
      throw new Error("agy workspace trust prompt: approve this dedicated workspace in the terminal, then retry");
    }
    throw new Error("agy TUI not safely idle; inspect statusLine and leave owner's live input intact");
  }
  const screen = await pane(socket, session);
  const url = parseRemoteUrl(screen);
  if (url) await fs.writeFile(path.join(stateDir, "remote-control-url.txt"), url + "\n", { mode: 0o600 });
  const previous = await fs.readFile(path.join(stateDir, "remote-control-url.txt"), "utf8").catch(() => "");
  return url ?? (exists ? previous.trim() : "");
}

export async function acquire(stateDir: string, deadline: number): Promise<() => Promise<void>> {
  const dir = path.join(stateDir, "dispatch.lock");
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "pid"), String(process.pid), { mode: 0o600 });
      return async () => { await fs.rm(dir, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pidText = await fs.readFile(path.join(dir, "pid"), "utf8").catch(() => "");
      const pid = Number(pidText);
      if (pid > 1 && Number.isInteger(pid)) {
        try { process.kill(pid, 0); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            // No replay; only stale mutex reclaimed. active.json remains.
            await fs.rename(dir, path.join(stateDir, `stale-lock-${Date.now()}`)).catch(() => {});
          }
        }
      }
      await sleep(1000);
    }
  }
  throw new Error("agy single Remote Control session busy: serialization timeout");
}

export async function deliver(ctx: AdapterExecutionContext, receipt: Receipt, title = "Antigravity execution report", label = "agy Remote Control"): Promise<void> {
  // Paperclip-owned run-scoped auth stays entirely inside the server adapter.
  // The live agy TUI sees only an issue ID and receipt path, NEVER the token.
  if (!ctx.authToken) throw new Error("missing scoped agent token for report/closure");
  // This adapter runs inside the same local Paperclip server process. Use the
  // private loopback listener instead of the public HTTPS URL, whose local
  // self-signed certificate is intentionally untrusted by Node fetch.
  const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid local Paperclip listen port");
  const api = new URL(`http://127.0.0.1:${port}`);
  const issue = encodeURIComponent(receipt.issueId);
  const invoke = async (method: string, suffix: string, body: unknown): Promise<unknown> => {
    const url = new URL(`/api/issues/${issue}${suffix}`, api);
    let response: Response;
    try {
      response = await fetch(url, {
        method, redirect: "manual",
        headers: { Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const cause = error && typeof error === "object" && "cause" in error && error.cause instanceof Error
        ? `: ${error.cause.message}` : "";
      throw new Error(`Paperclip local ${method} ${suffix} network failed${cause}`);
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`Paperclip ${method} ${suffix} returned HTTP ${response.status}`);
    return method === "GET" ? await response.json().catch(() => null) : null;
  };
  // A rerun on an issue that already has a report must send the revision it replaces, or PUT returns 409.
  const existing = await invoke("GET", "/documents/report", undefined) as { latestRevisionId?: unknown } | null;
  const baseRevisionId = typeof existing?.latestRevisionId === "string" ? existing.latestRevisionId : undefined;
  await invoke("PUT", "/documents/report", {
    title, format: "markdown", body: receipt.report,
    changeSummary: `${label} run ${ctx.runId}`,
    ...(baseRevisionId ? { baseRevisionId } : {}),
  });
  await invoke("PATCH", "", { status: "done" });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = ctx.config;
  const session = asString(cfg.tmuxSession, "agy");
  const socket = asString(cfg.tmuxSocket, "paperclip-agy-rc");
  const stateDir = path.resolve(asString(cfg.stateDir, path.join(os.homedir(), ".paperclip/agy-rc-state")));
  const cwd = path.resolve(asString(cfg.cwd, path.join(os.homedir(), ".paperclip/agy-rc-workspace")));
  assertWorkableCwd(cwd);
  const requestedModel = asString(cfg.model, DEFAULT_MODEL);
  const model = AGY_MODELS.includes(requestedModel as typeof AGY_MODELS[number]) ? requestedModel : DEFAULT_MODEL;
  const issueId = asString(ctx.context.issueId, asString(ctx.context.taskId, ""));
  const timeoutMs = Math.min(3600, Math.max(30, Number(cfg.timeoutSec) || 600)) * 1000;
  let unlock: (() => Promise<void>) | undefined;
  let dispatched = false;
  const failure = (reason: string, timedOut = false): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut, model, provider: "google", biller: "google",
    billingType: "subscription", costStatus: "unpriced", errorMessage: reason,
    ...(dispatched ? {} : { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } }),
  });
  try {
    resolveAgyModel(requestedModel);
    if (!ID.test(socket) || !ID.test(session)) throw new Error("invalid tmux socket/session");
    if (!issueId) throw new Error("agy adapter requires one issueId/taskId");
    if (!ctx.authToken) throw new Error("agy adapter requires a Paperclip run-scoped token before dispatch");
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== "local")
      throw new Error("agy TUI adapter runs on Mac Pro local host only");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    unlock = await acquire(stateDir, Date.now() + timeoutMs);
    const activePath = path.join(stateDir, "active.json");
    const adopted = adoptableActive(await fs.readFile(activePath, "utf8").catch(() => ""), issueId, stateDir);
    const rcUrl = await ensureSession(socket, session, cwd, stateDir, Boolean(adopted), model);
    if (!rcUrl) throw new Error("agy RC URL unavailable: use /remote-control in its TUI, then retry");
    // Owner 2026-11-03: auto re-pin, logged. The URL rotates on every agy restart; ensureSession only reads it from the
    // adapter-owned private tmux socket/session, so a new URL there is the same owned instance. The pin lives in
    // stateDir (cfg.expectedRemoteControlUrl is only the initial seed). An in-flight adopted dispatch stays strict below.
    const pinPath = path.join(stateDir, "rc-url.json");
    const pinned = await fs.readFile(pinPath, "utf8").then((t) => asString(JSON.parse(t)?.url, "")).catch(() => "")
      || asString(cfg.expectedRemoteControlUrl, rcUrl);
    if (pinned !== rcUrl) {
      await ctx.onLog("stdout", `[agy] RC URL re-pinned ${pinned} -> ${rcUrl} (owned tmux ${socket}/${session})\n`);
    }
    if (pinned !== rcUrl || !(await fs.stat(pinPath).catch(() => null)))
      await fs.writeFile(pinPath, JSON.stringify({ url: rcUrl, previous: pinned === rcUrl ? null : pinned, at: new Date().toISOString(), runId: ctx.runId }), { mode: 0o600 });
    let receiptRunId = ctx.runId;
    let receiptPath = path.join(stateDir, `receipt-${ctx.runId}.json`);
    let conversationId: string | null = null;
    if (adopted) {
      if (adopted.rcUrl !== rcUrl) throw new Error("agy RC URL changed since the adopted dispatch; operator reconciliation required");
      // The original prompt is already in the live conversation: never re-send it.
      receiptRunId = adopted.runId;
      receiptPath = adopted.receiptPath;
      conversationId = adopted.conversationId ?? null;
      ctx.onDispatch?.();
      dispatched = true;
      await ctx.onLog("stdout", `[agy] Adopting dispatched run ${adopted.runId} for issue ${issueId}; no re-dispatch; receipt ${receiptPath}\n`);
    } else {
    const before = await inspectRemoteConversation(socket, session, stateDir, cwd);
    if (before.url !== rcUrl) throw new Error("agy RC instance URL changed during inspection");
    // Verify /new via /remote-control's live conversation ID, NOT the cache:
    // last_conversations.json is updated only after a model turn in agy 1.4.12.
    await send(socket, session, "/new", stateDir, cwd, before.id);
    await sleep(500);
    if (!(await waitIdle(socket, session, stateDir, cwd, Date.now() + 12_000)))
      throw new Error("agy /new did not settle to an idle prompt");
    const fresh = await inspectRemoteConversation(socket, session, stateDir, cwd);
    if (fresh.url !== rcUrl || fresh.id === before.id)
      throw new Error("agy /new did not isolate a conversation under the same RC instance");
    conversationId = fresh.id;
    const promptBase = asString(cfg.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context);
    const instructionsFilePath = asString(cfg.instructionsFilePath, "");
    const instructionsPrefix = instructionsFilePath
      ? await fs.readFile(instructionsFilePath, "utf8")
      : "";
    const intro = renderTemplate(promptBase, {
      agent: ctx.agent, run: { id: ctx.runId }, context: ctx.context, companyId: ctx.agent.companyId,
    });
    const instructions = [
      `Paperclip run ${ctx.runId}, issue ${issueId}. Work on ONLY the assigned issue.`,
      "Your actions are visible and steerable through the single Antigravity Remote Control session.",
      `Use ${modelLabel(model)}. Do not switch models.`,
      " Never use secrets or guess Paperclip API credentials.",
      "Finish the requested issue work, then write a JSON receipt via your write_to_file tool",
      `to ${receiptPath} with exactly these keys: runId = ${ctx.runId}, issueId = ${issueId},`,
      'status = "done", summary = a short factual summary, report = a detailed Markdown result (at least 250 characters).',
      "Write this only once actual work is complete. The Paperclip adapter will publish the report and close the issue",
      "under the run's scoped identity. Do NOT update the issue yourself. Do not write a done receipt on failure.",
      "If blocked, explain the blocker visibly without a done receipt. The adapter will leave the issue open.",
    ].join(" ");
    const prompt = normalizeOneLine(joinPromptSections([instructionsPrefix, intro, taskContextNote, wakePrompt, instructions]));
    if (prompt.length > 50_000) throw new Error("agy prompt exceeds TUI paste budget");
    // No checkpoint is created for an initial guard refusal. Once a checkpoint
    // exists, a crash or uncertain paste still requires reconciliation.
    const preflight = await inputReadiness(socket, session, stateDir, cwd, conversationId);
    if (!preflight.allowed) throw new Error(`agy input guard refused before dispatch: ${preflight.reason}`);
    await fs.writeFile(activePath, JSON.stringify({
      runId: ctx.runId, issueId, receiptPath, rcUrl, tmuxSocket: socket, tmuxSession: session,
      conversationId, startedAt: new Date().toISOString(),
    }, null, 2), { flag: "wx", mode: 0o600 });
    ctx.onDispatch?.();
    dispatched = true;
    await ctx.onLog("stdout", `[agy] Dispatching issue ${issueId} in shared RC ${rcUrl}; receipt ${receiptPath}\n`);
    await send(socket, session, prompt, stateDir, cwd, conversationId);
    }
    const deadline = Date.now() + timeoutMs;
    let receipt: Receipt | null = null;
    let idleWithoutReceipt = 0;
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error("agy run cancelled; shared TUI left intact, active checkpoint preserved");
      const raw = await fs.readFile(receiptPath, "utf8").catch(() => "");
      if (raw) {
        receipt = parseReceipt(raw, receiptRunId, issueId);
        if (await waitIdle(socket, session, stateDir, cwd, Date.now() + 4000, conversationId)) break;
      } else if (adopted) {
        // An adopted turn that has gone idle with no receipt will not finish by itself.
        idleWithoutReceipt = (await inputReadiness(socket, session, stateDir, cwd, conversationId)).allowed
          ? idleWithoutReceipt + 1 : 0;
        if (idleWithoutReceipt >= 5)
          return failure("agy adopted dispatch is idle without a receipt; checkpoint retained for operator reconciliation");
      }
      // A terminated pane must never be mistaken for successful agent work.
      await tmux(socket, ["has-session", ...target(session)]);
      await sleep(1100);
    }
    if (!receipt || !(await waitIdle(socket, session, stateDir, cwd, Date.now() + 1500, conversationId)))
      return failure("agy did not produce a validated completion receipt at an idle TUI; checkpoint retained", true);
    await deliver(ctx, receipt);
    await ctx.onLog("stdout", `[agy] Done ${issueId}: ${receipt.summary}; conversation=${conversationId ?? "unknown"}\n`);
    await fs.rm(activePath); // completed only after authenticated report + issue closure
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "google", biller: "google", model,
      billingType: "subscription", costStatus: "unpriced", summary: receipt.summary,
      sessionId: conversationId, sessionDisplayId: conversationId,
      sessionParams: { sessionId: conversationId, cwd, remoteControlUrl: rcUrl, tmuxSocket: socket, tmuxSession: session },
      resultJson: { issueId, receiptPath, remoteControlUrl: rcUrl, conversationId, reportPublished: true, issueClosed: true },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await ctx.onLog("stderr", `[agy] ${error}\n`);
    return failure(error);
  } finally {
    if (unlock) await unlock();
  }
}
