/**
 * Paperclip -> one long-lived interactive Claude Code session with Remote
 * Control. `claude --print --remote-control` is ignored by the CLI (never
 * listed on the owner's phone), so this drives the SAME interactive process
 * the owner sees and steers under a stable session name. Modeled on agy:
 * serialized, receipt-closed, same-issue adoption after restart, no replay.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections, renderTemplate, selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  acquire, adoptableActive, deliver, normalizeOneLine, pane, parseReceipt, pasteSubmit, tmux,
  type Receipt,
} from "../agy/execute.js";

const CLAUDE = "/opt/homebrew/bin/claude";
const MODELS = new Set(["claude-sonnet-5-5", "claude-haiku-5-5"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const ID = /^[a-zA-Z0-9_-]{1,55}$/;
const NAME = /^[A-Za-z0-9 ._-]{1,60}$/;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
/** Idle = input box + permission footer visible and no turn or dialog in progress. */
export function isClaudeIdle(screen: string): boolean {
  const end = screen.trimEnd().slice(-900);
  return /(?:^|\n)❯/.test(end) && /bypass permissions on/.test(end) &&
    !/esc to interrupt|Do you want to|❯ 1\. /i.test(end);
}
export function parseClaudeRcUrl(screen: string): string | null {
  return screen.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0] ?? null;
}
/** Claude Code stores each conversation as <projects>/<cwd slug>/<uuid>.jsonl. */
export function projectDir(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}
async function newestConversation(cwd: string): Promise<string | null> {
  const dir = projectDir(cwd);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => /^[0-9a-f-]{36}\.jsonl$/.test(n));
  let best: { id: string; t: number } | null = null;
  for (const n of names) {
    const t = (await fs.stat(path.join(dir, n)).catch(() => null))?.birthtimeMs ?? 0;
    if (!best || t > best.t) best = { id: n.slice(0, 36), t };
  }
  return best?.id ?? null;
}
async function waitIdle(socket: string, session: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try { if (isClaudeIdle(await pane(socket, session))) return true; } catch { return false; }
    await sleep(900);
  }
  return false;
}
async function ensureSession(socket: string, session: string, cwd: string, stateDir: string,
  name: string, model: string, effort: string): Promise<string> {
  let exists = true;
  try { await tmux(socket, ["has-session", "-t", session]); } catch { exists = false; }
  if (!exists) {
    await fs.mkdir(cwd, { recursive: true });
    // exec mode, no shell. Background tasks would die with no owner; keep tools foreground.
    await tmux(socket, ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", cwd,
      "-e", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
      CLAUDE, "--remote-control", name, "--name", name, "--model", model, "--effort", effort,
      "--dangerously-skip-permissions"]);
  }
  const processName = (await tmux(socket, ["display-message", "-p", "-t", session, "#{pane_current_command}"])).trim();
  if (processName !== "claude") throw new Error(`tmux pane is ${processName}, not claude; refusing to commandeer it`);
  if (!(await waitIdle(socket, session, Date.now() + 25_000))) {
    const s = await pane(socket, session);
    if (/trust the files|Do you trust/i.test(s))
      throw new Error("Claude workspace trust prompt: approve this dedicated workspace in the terminal, then retry");
    throw new Error("Claude TUI not idle; leave the owner's live work intact");
  }
  const urlFile = path.join(stateDir, "remote-control-url.txt");
  const url = parseClaudeRcUrl(await pane(socket, session));
  if (url) await fs.writeFile(urlFile, url + "\n", { mode: 0o600 });
  return url ?? (await fs.readFile(urlFile, "utf8").catch(() => "")).trim();
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = ctx.config;
  const session = asString(cfg.tmuxSession, "claude");
  const socket = asString(cfg.tmuxSocket, "pc-claude-rc");
  const name = asString(cfg.remoteControlName, "Paperclip Claude");
  const stateDir = path.resolve(asString(cfg.stateDir, path.join(os.homedir(), ".paperclip/claude-rc-state")));
  const cwd = path.resolve(asString(cfg.cwd, path.join(os.homedir(), ".paperclip/claude-rc-workspace")));
  const model = asString(cfg.model, "claude-sonnet-5-5");
  const effort = asString(cfg.effort, "medium");
  const issueId = asString(ctx.context.issueId, asString(ctx.context.taskId, ""));
  const timeoutMs = Math.min(3600, Math.max(30, Number(cfg.timeoutSec) || 900)) * 1000;
  let unlock: (() => Promise<void>) | undefined;
  let dispatched = false;
  const failure = (reason: string, timedOut = false): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut, model, provider: "anthropic", biller: "anthropic",
    billingType: "subscription", costStatus: "unpriced", errorMessage: reason,
    ...(dispatched ? {} : { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } }),
  });
  try {
    if (!MODELS.has(model)) throw new Error(`claude_rc_local permits only ${[...MODELS].join(", ")}; received ${model}`);
    if (!EFFORTS.has(effort)) throw new Error(`invalid effort ${effort}`);
    if (!ID.test(socket) || !ID.test(session) || !NAME.test(name)) throw new Error("invalid tmux socket/session/name");
    if (!issueId) throw new Error("claude_rc_local requires one issueId/taskId");
    if (!ctx.authToken) throw new Error("claude_rc_local requires a Paperclip run-scoped token before dispatch");
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== "local")
      throw new Error("claude_rc_local runs on the Mac Pro local host only");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    unlock = await acquire(stateDir, Date.now() + timeoutMs);
    const activePath = path.join(stateDir, "active.json");
    const adopted = adoptableActive(await fs.readFile(activePath, "utf8").catch(() => ""), issueId, stateDir);
    const rcUrl = await ensureSession(socket, session, cwd, stateDir, name, model, effort);
    if (!rcUrl) throw new Error("Claude RC URL unavailable; refusing to dispatch to an unverified session");
    const expected = asString(cfg.expectedRemoteControlUrl, rcUrl);
    if (expected !== rcUrl) throw new Error("Claude RC URL changed; refusing to dispatch to an unverified session");
    let receiptRunId = ctx.runId;
    let receiptPath = path.join(stateDir, `receipt-${ctx.runId}.json`);
    let conversationId: string | null = null;
    if (adopted) {
      if (adopted.rcUrl !== rcUrl) throw new Error("Claude RC URL changed since the adopted dispatch; operator reconciliation required");
      receiptRunId = adopted.runId;
      receiptPath = adopted.receiptPath;
      conversationId = adopted.conversationId ?? null;
      ctx.onDispatch?.();
      dispatched = true;
      await ctx.onLog("stdout", `[claude-rc] Adopting dispatched run ${adopted.runId} for issue ${issueId}; no re-dispatch; receipt ${receiptPath}\n`);
    } else {
      const before = await newestConversation(cwd);
      await pasteSubmit(socket, session, "/clear", stateDir);
      await sleep(800);
      if (!(await waitIdle(socket, session, Date.now() + 12_000)))
        throw new Error("Claude /clear did not settle to an idle prompt");
      conversationId = await newestConversation(cwd);
      if (!conversationId || conversationId === before)
        throw new Error("Claude /clear did not start an isolated conversation");
      const promptBase = asString(cfg.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context);
      const instructionsFilePath = asString(cfg.instructionsFilePath, "");
      const instructionsPrefix = instructionsFilePath ? await fs.readFile(instructionsFilePath, "utf8") : "";
      const intro = renderTemplate(promptBase, {
        agent: ctx.agent, run: { id: ctx.runId }, context: ctx.context, companyId: ctx.agent.companyId,
      });
      const instructions = [
        `Paperclip run ${ctx.runId}, issue ${issueId}. Work on ONLY the assigned issue.`,
        "This is the owner's live Claude Code Remote Control session: messages they send mid-task are steering for this issue.",
        "Run every command in the foreground; never background a tool call. Never use secrets or guess Paperclip API credentials.",
        "Finish the requested issue work, then use your Write tool to create the JSON receipt",
        `${receiptPath} with exactly these keys: runId = ${ctx.runId}, issueId = ${issueId},`,
        'status = "done", summary = a short factual summary, report = a detailed Markdown result (at least 250 characters).',
        "Write it only once actual work is complete. The Paperclip adapter publishes the report and closes the issue",
        "under the run's scoped identity. Do NOT update the issue yourself. Do not write a done receipt on failure;",
        "if blocked, explain the blocker visibly and stop.",
      ].join(" ");
      const prompt = normalizeOneLine(joinPromptSections([instructionsPrefix, intro, taskContextNote, wakePrompt, instructions]));
      if (prompt.length > 50_000) throw new Error("Claude prompt exceeds TUI paste budget");
      await fs.writeFile(activePath, JSON.stringify({
        runId: ctx.runId, issueId, receiptPath, rcUrl, tmuxSocket: socket, tmuxSession: session,
        conversationId, startedAt: new Date().toISOString(),
      }, null, 2), { flag: "wx", mode: 0o600 });
      ctx.onDispatch?.();
      dispatched = true;
      await ctx.onLog("stdout", `[claude-rc] Dispatching issue ${issueId} into "${name}" ${rcUrl}; conversation ${conversationId}; receipt ${receiptPath}\n`);
      await pasteSubmit(socket, session, prompt, stateDir);
    }
    const deadline = Date.now() + timeoutMs;
    let receipt: Receipt | null = null;
    let idleWithoutReceipt = 0;
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error("Claude run cancelled; shared TUI left intact, active checkpoint preserved");
      const raw = await fs.readFile(receiptPath, "utf8").catch(() => "");
      if (raw) {
        receipt = parseReceipt(raw, receiptRunId, issueId);
        if (await waitIdle(socket, session, Date.now() + 4000)) break;
      } else if (adopted) {
        idleWithoutReceipt = isClaudeIdle(await pane(socket, session)) ? idleWithoutReceipt + 1 : 0;
        if (idleWithoutReceipt >= 5)
          return failure("Claude adopted dispatch is idle without a receipt; checkpoint retained for operator reconciliation");
      }
      await tmux(socket, ["has-session", "-t", session]);
      await sleep(1100);
    }
    if (!receipt || !(await waitIdle(socket, session, Date.now() + 1500)))
      return failure("Claude did not produce a validated completion receipt at an idle TUI; checkpoint retained", true);
    await deliver(ctx, receipt, "Claude Code execution report", "Claude Remote Control");
    await ctx.onLog("stdout", `[claude-rc] Done ${issueId}: ${receipt.summary}; conversation=${conversationId ?? "unknown"}\n`);
    await fs.rm(activePath);
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model,
      billingType: "subscription", costStatus: "unpriced", summary: receipt.summary,
      sessionId: conversationId, sessionDisplayId: conversationId,
      sessionParams: { sessionId: conversationId, cwd, remoteControlUrl: rcUrl, remoteControlName: name, tmuxSocket: socket, tmuxSession: session },
      resultJson: { issueId, receiptPath, remoteControlUrl: rcUrl, conversationId, reportPublished: true, issueClosed: true },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await ctx.onLog("stderr", `[claude-rc] ${error}\n`);
    return failure(error);
  } finally {
    if (unlock) await unlock();
  }
}
