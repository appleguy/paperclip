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
  buildPaperclipEnv, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections, renderTemplate, selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";

const runFile = promisify(execFile);
const AGY = "/opt/homebrew/bin/agy";
const MODEL = "gemini-3.8-flash-low";
const ID = /^[a-zA-Z0-9_-]{1,55}$/;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
export function normalizeOneLine(value: string): string {
  // tmux paste-buffer with embedded newlines submits partial TUI prompts.
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
export function parseRemoteUrl(screen: string): string | null {
  return screen.match(/https:\/\/antigravity\.google\.com\/r\/[a-zA-Z0-9-]+/)?.[0] ?? null;
}
export function isIdleScreen(screen: string): boolean {
  const end = screen.trimEnd().slice(-700);
  return /(?:^|\n)>\s*\n[─\s]*\n\? for shortcuts/m.test(end) &&
    !/esc to cancel|Generating\.\.\.|Working\.\.\./i.test(end);
}
type Receipt = { runId: string; issueId: string; status: string; summary: string; report: string };
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

async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await runFile("/opt/homebrew/bin/tmux", ["-L", socket, ...args], {
    timeout: 10_000, maxBuffer: 2_000_000,
  });
  return stdout;
}
const target = (session: string) => ["-t", session];
async function pane(socket: string, session: string): Promise<string> {
  return tmux(socket, ["capture-pane", ...target(session), "-p", "-J", "-S", "-150"]);
}
async function send(socket: string, session: string, message: string, stateDir: string): Promise<void> {
  if (/[\r\n]/.test(message)) throw new Error("multiline TUI submissions forbidden");
  // Using a private UTF-8 buffer file keeps large prompts out of argv.
  const file = path.join(stateDir, "dispatch-input.txt");
  await fs.writeFile(file, message, { mode: 0o600 });
  try {
    await tmux(socket, ["load-buffer", file]);
    await tmux(socket, ["paste-buffer", "-d", ...target(session)]);
    await tmux(socket, ["send-keys", ...target(session), "Enter"]);
  } finally {
    await fs.rm(file, { force: true });
  }
}
async function waitIdle(socket: string, session: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try { if (isIdleScreen(await pane(socket, session))) return true; } catch { return false; }
    await sleep(900);
  }
  return false;
}
async function ensureSession(socket: string, session: string, cwd: string, stateDir: string): Promise<string> {
  let exists = true;
  try { await tmux(socket, ["has-session", ...target(session)]); } catch { exists = false; }
  if (!exists) {
    await fs.mkdir(cwd, { recursive: true });
    // tmux exec mode: no interpolated shell source or arbitrary model selection.
    await tmux(socket, ["new-session", "-d", "-s", session, "-c", cwd,
      AGY, "--remote-control", "--dangerously-skip-permissions", "--model", MODEL]);
  }
  const processName = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_command}"])).trim();
  if (processName !== "agy") throw new Error(`tmux pane is ${processName}, not agy; refusing to commandeer it`);
  if (!(await waitIdle(socket, session, Date.now() + 20_000))) {
    const s = await pane(socket, session);
    if (/Do you trust the contents/.test(s)) {
      throw new Error("agy workspace trust prompt: approve this dedicated workspace in the terminal, then retry");
    }
    throw new Error("agy TUI not idle; leave the owner's live work intact");
  }
  const screen = await pane(socket, session);
  const url = parseRemoteUrl(screen);
  if (url) await fs.writeFile(path.join(stateDir, "remote-control-url.txt"), url + "\n", { mode: 0o600 });
  const previous = await fs.readFile(path.join(stateDir, "remote-control-url.txt"), "utf8").catch(() => "");
  return url ?? previous.trim();
}

async function acquire(stateDir: string, deadline: number): Promise<() => Promise<void>> {
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

async function currentConversationId(cwd: string): Promise<string | null> {
  try {
    const body = JSON.parse(await fs.readFile(
      path.join(os.homedir(), ".gemini/antigravity-cli/cache/last_conversations.json"), "utf8",
    )) as Record<string, unknown>;
    const id = body[path.resolve(cwd)];
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

async function deliver(ctx: AdapterExecutionContext, receipt: Receipt): Promise<void> {
  // Paperclip-owned run-scoped auth stays entirely inside the server adapter.
  // The live agy TUI sees only an issue ID and receipt path, NEVER the token.
  if (!ctx.authToken) throw new Error("missing scoped agent token for report/closure");
  const env = buildPaperclipEnv(ctx.agent, ctx.agentIdentity);
  const api = new URL(env.PAPERCLIP_API_URL);
  if (!["http:", "https:"].includes(api.protocol)) throw new Error("unsupported Paperclip API protocol");
  const issue = encodeURIComponent(receipt.issueId);
  const invoke = async (method: string, suffix: string, body: unknown) => {
    const url = new URL(`/api/issues/${issue}${suffix}`, api);
    const response = await fetch(url, {
      method, redirect: "manual",
      headers: { Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Paperclip ${method} ${suffix} returned HTTP ${response.status}`);
  };
  await invoke("PUT", "/documents/report", {
    title: "Antigravity execution report", format: "markdown", body: receipt.report,
    changeSummary: `agy Remote Control run ${ctx.runId}`,
  });
  await invoke("PATCH", "", { status: "done" });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = ctx.config;
  const session = asString(cfg.tmuxSession, "agy");
  const socket = asString(cfg.tmuxSocket, "paperclip-agy-rc");
  const stateDir = path.resolve(asString(cfg.stateDir, path.join(os.homedir(), ".paperclip/agy-rc-state")));
  const cwd = path.resolve(asString(cfg.cwd, path.join(os.homedir(), ".paperclip/agy-rc-workspace")));
  const model = asString(cfg.model, MODEL);
  const issueId = asString(ctx.context.issueId, asString(ctx.context.taskId, ""));
  const timeoutMs = Math.min(3600, Math.max(30, Number(cfg.timeoutSec) || 600)) * 1000;
  let unlock: (() => Promise<void>) | undefined;
  let dispatched = false;
  const failure = (reason: string, timedOut = false): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut, model: MODEL, provider: "google", biller: "google",
    billingType: "subscription", costStatus: "unpriced", errorMessage: reason,
    ...(dispatched ? {} : { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } }),
  });
  try {
    if (model !== MODEL) throw new Error(`agy adapter permits only ${MODEL}; received ${model}`);
    if (!ID.test(socket) || !ID.test(session)) throw new Error("invalid tmux socket/session");
    if (!issueId) throw new Error("agy adapter requires one issueId/taskId");
    if (!ctx.authToken) throw new Error("agy adapter requires a Paperclip run-scoped token before dispatch");
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== "local")
      throw new Error("agy TUI adapter runs on Mac Pro local host only");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    unlock = await acquire(stateDir, Date.now() + timeoutMs);
    const activePath = path.join(stateDir, "active.json");
    const active = await fs.readFile(activePath, "utf8").catch(() => "");
    if (active) throw new Error("agy previous task unresolved; inspect active.json and its receipt before dispatch. Never replay actions");
    const rcUrl = await ensureSession(socket, session, cwd, stateDir);
    if (!rcUrl) throw new Error("agy RC URL unavailable: use /remote-control in its TUI, then retry");
    const expected = asString(cfg.expectedRemoteControlUrl, rcUrl);
    if (expected !== rcUrl) throw new Error("agy RC URL changed; refusing to dispatch to an unverified session");
    const beforeId = await currentConversationId(cwd);
    // One TUI process, one /r/ URL, isolated conversations via /new.
    await send(socket, session, "/new", stateDir);
    if (!(await waitIdle(socket, session, Date.now() + 12_000)))
      throw new Error("agy /new did not settle to an idle prompt");
    const receiptPath = path.join(stateDir, `receipt-${ctx.runId}.json`);
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
      "Use Gemini 3.8 Flash Low. Do not switch models. Never use secrets or guess Paperclip API credentials.",
      "Finish the requested issue work, then write a JSON receipt via your write_to_file tool",
      `to ${receiptPath} with exactly these keys: runId = ${ctx.runId}, issueId = ${issueId},`,
      'status = "done", summary = a short factual summary, report = a detailed Markdown result (at least 250 characters).',
      "Write this only once actual work is complete. The Paperclip adapter will publish the report and close the issue",
      "under the run's scoped identity. Do NOT update the issue yourself. Do not write a done receipt on failure.",
      "If blocked, explain the blocker visibly without a done receipt. The adapter will leave the issue open.",
    ].join(" ");
    const prompt = normalizeOneLine(joinPromptSections([instructionsPrefix, intro, taskContextNote, wakePrompt, instructions]));
    if (prompt.length > 50_000) throw new Error("agy prompt exceeds TUI paste budget");
    await fs.writeFile(activePath, JSON.stringify({
      runId: ctx.runId, issueId, receiptPath, rcUrl, tmuxSocket: socket, tmuxSession: session,
      startedAt: new Date().toISOString(),
    }, null, 2), { flag: "wx", mode: 0o600 });
    ctx.onDispatch?.();
    dispatched = true;
    await ctx.onLog("stdout", `[agy] Dispatching issue ${issueId} in shared RC ${rcUrl}; receipt ${receiptPath}\n`);
    await send(socket, session, prompt, stateDir);
    const deadline = Date.now() + timeoutMs;
    let receipt: Receipt | null = null;
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error("agy run cancelled; shared TUI left intact, active checkpoint preserved");
      const raw = await fs.readFile(receiptPath, "utf8").catch(() => "");
      if (raw) {
        receipt = parseReceipt(raw, ctx.runId, issueId);
        if (await waitIdle(socket, session, Date.now() + 4000)) break;
      }
      // A terminated pane must never be mistaken for successful agent work.
      await tmux(socket, ["has-session", ...target(session)]);
      await sleep(1100);
    }
    if (!receipt || !(await waitIdle(socket, session, Date.now() + 1500)))
      return failure("agy did not produce a validated completion receipt at an idle TUI; checkpoint retained", true);
    const conversationId = await currentConversationId(cwd);
    if (beforeId && conversationId === beforeId)
      throw new Error("agy /new did not create a distinct conversation ID; leaving checkpoint for inspection");
    await deliver(ctx, receipt);
    await ctx.onLog("stdout", `[agy] Done ${issueId}: ${receipt.summary}; conversation=${conversationId ?? "unknown"}\n`);
    await fs.rm(activePath); // completed only after authenticated report + issue closure
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "google", biller: "google", model: MODEL,
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
