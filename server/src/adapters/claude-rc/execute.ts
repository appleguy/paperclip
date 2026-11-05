/**
 * One interactive Claude Code session, shared by Paperclip and the owner via
 * Remote Control. Primary transport: a private MCP channel in that SAME TUI.
 * The tmux input path is guarded compatibility fallback, never a retry of
 * an uncertain channel write. Only the existing JSON receipt + deliver()
 * may publish a report or close the issue.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readableRuntimePath } from "@paperclipai/adapter-utils/readable-runtime-paths";
import { assertAssembledPrompt, preflightSessionPrompt, applyPromptRotation } from "@paperclipai/adapter-utils/token-preflight";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections, renderTemplate, selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  acquire, adoptableActive, checkpointRunState, isTargetBusyRefusal, normalizeOneLine, parseReceipt, receiptFilePath, target, tmux, tryAcquire,
  type Receipt,
} from "../agy/execute.js";
import { deriveRcName, reportsToDepth, sanitizeRcName, slotRcName, type RcAgentNode } from "./rc-name.js";
import { gateReceiptRaw, refusalMessage, productionDeps } from "./done-gate.js";
import { captureDoneGateBaseline, type GateBaseline } from "./done-gate-provenance.js";
import { isReviewContinuation, reconcileForeignSettlement, settleOutcome } from "./settlement.js";
import {
  CHANNEL_NAME, findBridgeRoot, prepareChannelHost, routeChannelInput, type ChannelHost,
  type ChannelStatus,
} from "./channel.js";

const CLAUDE = "/opt/homebrew/bin/claude";
const MODELS = new Set(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ID = /^[a-zA-Z0-9_-]{1,55}$/;
/** SCO-965: one tmux seat per concurrent run. Slot 0 is the agent's configured seat, unchanged. */
export type RcSlot = { index: number; session: string; stateDir: string };
export const RC_MAX_SLOTS = 4;
export function rcSlotCount(slots: unknown): number {
  const n = Math.trunc(Number(slots));
  return Number.isFinite(n) ? Math.min(RC_MAX_SLOTS, Math.max(1, n)) : 1;
}
export function rcSlot(index: number, session: string, stateDir: string): RcSlot {
  return index === 0 ? { index, session, stateDir }
    : { index, session: `${session}-s${index}`, stateDir: path.join(stateDir, `s${index}`) };
}

/**
 * Pick and lock one seat: the seat already holding this issue's checkpoint (adoption), else the first seat
 * with no checkpoint after verified foreign settlements are archived. One seat keeps today's exact path.
 */
export async function claimSlot(
  ctx: AdapterExecutionContext, slots: RcSlot[], issueId: string, deadline: number,
): Promise<{ slot: RcSlot; unlock: () => Promise<void> }> {
  if (ctx.signal?.aborted) throw new Error("Claude run cancelled; shared TUI left intact, active checkpoint preserved");
  for (const slot of slots) await fs.mkdir(slot.stateDir, { recursive: true, mode: 0o700 });
  const activeOf = (slot: RcSlot) => fs.readFile(path.join(slot.stateDir, "active.json"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  let owner: RcSlot | undefined;
  for (const slot of slots) {
    try {
      if ((JSON.parse(await activeOf(slot)) as { issueId?: unknown }).issueId === issueId) { owner = slot; break; }
    } catch { /* unreadable checkpoints are retained below */ }
  }
  if (ctx.context.paperclipRestartReattach === true) {
    if (!owner) throw new Error("claude_rc_local restart checkpoint missing; provider ownership requires reconciliation");
    const unlock = await acquire(owner.stateDir, deadline);
    try {
      const active = adoptableActive(await activeOf(owner), issueId, owner.stateDir, "claude_rc_local");
      if (!active || active.runId !== ctx.runId) throw new Error("claude_rc_local restart checkpoint run mismatch; provider ownership requires reconciliation");
      return { slot: owner, unlock };
    } catch (error) { await unlock(); throw error; }
  }
  for (const slot of owner ? [owner] : slots) {
    const unlock = await tryAcquire(slot.stateDir);
    if (!unlock) continue;
    try {
      const raw = await activeOf(slot);
      const state = await checkpointRunState(ctx, raw);
      if (state === "live" || state === "unknown") { await unlock(); continue; }
      await reconcileForeignSettlement(ctx, slot.stateDir, path.join(slot.stateDir, "active.json"));
      // Same-issue adoption observes the original operation; it never submits a second one.
      adoptableActive(await activeOf(slot), issueId, slot.stateDir, "claude_rc_local");
      return { slot, unlock };
    } catch (error) {
      await unlock();
      if (!isTargetBusyRefusal(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  throw new Error("claude_rc_local previous task unresolved; Remote Control seat busy; wake coalesced without dispatch");
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
/** Screen text without dim (ghost prompt suggestion) spans or other escapes. */
async function claudePane(socket: string, session: string): Promise<string> {
  const raw = await tmux(socket, ["capture-pane", ...target(session), "-p", "-J", "-e", "-S", "-150"]);
  return raw.replace(/\x1b\[2m[^\x1b\n]*/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
export function isClaudeIdle(screen: string): boolean {
  const tail = screen.replace(/\r/g, "").trimEnd().split("\n").slice(-18);
  const i = tail.findLastIndex(l => /^\s*❯/.test(l));
  if (i < 0 || tail.length - i > 12) return false;
  const input = tail[i]!.replace(/^\s*❯/, "").trim();
  if (input !== "" && !/^Try "[^"]*"$/.test(input)) return false;
  const after = tail.slice(i + 1);
  if (!after.some(l => /bypass permissions on/i.test(l))) return false;
  // Only terminal rules/blank lines may occur between the editor and footer.
  if (after.some(l => l.trim() && !/^[\s─━═│┃]+$/.test(l) &&
    !/bypass permissions on|shift\+tab to cycle/i.test(l))) return false;
  // Spinner tokens are capitalized and end in an ellipsis; plain prose such as
  // "one pane per generating session" in the last answer must not read as busy.
  const text = tail.join("\n");
  return !/esc to\b|Do you want to|❯ 1\./i.test(text) && !/^\s*\S+ [A-Z][a-z]+…/m.test(text);
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
/**
 * The conversation this seat's own Claude process holds, from Claude Code's
 * ~/.claude/sessions/<pid>.json (its tmux field names the pane). Seats that
 * share a cwd make newestConversation pick another seat's file, which failed
 * the keep check and cleared the Tensor64 Lead (SCO-866).
 */
export async function seatConversation(session: string, cwd: string, dir = path.join(os.homedir(), ".claude", "sessions")): Promise<string | null> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => /^\d+\.json$/.test(n));
  let best: { id: string; t: number } | null = null;
  for (const n of names) {
    const s = await fs.readFile(path.join(dir, n), "utf8").then(t => JSON.parse(t) as Record<string, unknown>).catch(() => null);
    if (!s || typeof s.sessionId !== "string" || s.cwd !== cwd || typeof s.tmux !== "string" || !s.tmux.startsWith(`${session}:`)) continue;
    try { process.kill(Number(s.pid), 0); } catch { continue; }
    const t = Number(s.updatedAt) || 0;
    if (!best || t > best.t) best = { id: s.sessionId, t };
  }
  return best?.id ?? null;
}
/**
 * SCO-713: the one-time --dangerously-load-development-channels notice (our own local bridge).
 * It is neither idle nor a permission prompt, so it must be confirmed on any run, not only in the
 * post-launch window, or the seat sits "waiting on you" with nothing to answer.
 */
export function isDevChannelPrompt(screen: string): boolean {
  return /Loading development channels/i.test(screen) && /I am using this for local development/i.test(screen);
}
/** Guard owner input only; a busy turn and Claude's editor placeholders are safe. */
export function isPromptEmpty(screen: string): boolean {
  const tail = screen.replace(/\r/g, "").trimEnd().split("\n").slice(-18);
  const line = tail.findLast(l => /^\s*❯/.test(l));
  if (line === undefined) return false;
  const input = line.replace(/^\s*❯/, "").trim();
  return input === "" || /^Try "[^"]*"$/.test(input) || input === "Press up to edit queued messages";
}
/** Type one slash command literally, then Enter; true when the harness echoed `expect`. */
export async function typeNativeGoal(socket: string, session: string, text: string, expect: RegExp): Promise<boolean> {
  const screen = await claudePane(socket, session);
  if (!isPromptEmpty(screen)) return false;
  // Large send-keys writes become pasted text instead of a slash command.
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 24) {
    await tmux(socket, ["send-keys", ...target(session), "-l", "--", chars.slice(i, i + 24).join("")]);
    await sleep(60);
  }
  await tmux(socket, ["send-keys", ...target(session), "Enter"]);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    // The echo line is rendered dim, which claudePane drops; match on the raw screen.
    const raw = await tmux(socket, ["capture-pane", ...target(session), "-p", "-J", "-e", "-S", "-30"]);
    if (expect.test(raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) return true;
  }
  return false;
}

/** Named, private tmux buffer; no prompt in argv and no shared paste buffer. */
async function sendClaudePane(socket: string, session: string, message: string, stateDir: string): Promise<void> {
  if (/[\r\n]/.test(message)) throw new Error("multiline TUI submission refused");
  if (!isPromptEmpty(await claudePane(socket, session)))
    throw new Error("Claude input guard refused: owner input nonempty");
  const inputFile = path.join(stateDir, `claude-input-${process.pid}.txt`);
  const buffer = `paperclip-claude-${process.pid}`;
  await fs.writeFile(inputFile, message, { mode: 0o600 });
  try {
    await tmux(socket, ["load-buffer", "-b", buffer, inputFile]);
    await tmux(socket, ["paste-buffer", "-p", "-r", "-d", "-b", buffer, ...target(session)]);
    await sleep(Math.min(3000, Math.max(350, 500 + Math.ceil(message.length / 1500) * 300)));
    await tmux(socket, ["send-keys", ...target(session), "Enter"]);
  } finally {
    await tmux(socket, ["delete-buffer", "-b", buffer]).catch(() => {});
    await fs.rm(inputFile, { force: true });
  }
}

/** fsync checkpoint before emission. Directory sync secures create/rename. */
async function writeCheckpoint(file: string, text: string, flag: "wx" | "w" = "w"): Promise<void> {
  const fd = await fs.open(file, flag, 0o600);
  try { await fd.writeFile(text); await fd.sync(); }
  finally { await fd.close(); }
  const parent = await fs.open(path.dirname(file), "r");
  try { await parent.sync(); }
  finally { await parent.close(); }
}
/** Mark possible effects durably BEFORE touching either transport. */
export async function recordDispatchMode(activePath: string, active: Record<string, unknown>, dispatchMode: "channel-pending" | "tmux-fallback"): Promise<void> {
  const temp = activePath + "." + process.pid + ".tmp";
  try {
    await writeCheckpoint(temp, JSON.stringify({ ...active, dispatchMode }, null, 2));
    await fs.rename(temp, activePath);
    const dir = await fs.open(path.dirname(activePath), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Silence is not settlement. Retain possible effects under the original op ID
 * across wakes/issues. Only a new-format pre-submit checkpoint with a successful,
 * empty bridge lookup proves neither transport was invoked and can free the seat.
 */
export async function reconcileOrphanActive(o: {
  stateDir: string; activePath: string; issueId: string; runId: string;
  live: (conversationId: string | null) => Promise<boolean>; paneIdle: () => Promise<boolean>;
  log: (m: string) => Promise<void> | void;
  status?: (opId: string) => Promise<ChannelStatus | null>;
  /** Same-issue checkpoints are only reconciled once this old (default 3 min), so a just-sent dispatch is never re-sent. */
  sameIssueMinAgeMs?: number;
}): Promise<"none" | "kept" | "archived"> {
  const raw = await fs.readFile(o.activePath, "utf8").catch(() => "");
  if (!raw) return "none";
  let prev: { op_id?: string; runId?: string; issueId?: string; receiptPath?: string; conversationId?: string | null; startedAt?: string; dispatchMode?: string };
  try { prev = JSON.parse(raw); } catch { prev = {}; }
  const op = asString(prev.op_id, asString(prev.runId, ""));
  if (!op || op === o.runId) return "none";
  if (prev.issueId === o.issueId) {
    // Age bounds pre-submit recovery only; it never establishes absence of effects.
    const started = Date.parse(asString(prev.startedAt, ""));
    if (!Number.isFinite(started) || Date.now() - started < (o.sameIssueMinAgeMs ?? 180_000)) return "none";
  }
  if (prev.receiptPath && await fs.stat(prev.receiptPath).then(() => true, () => false)) return "none";
  let status: ChannelStatus | null;
  try {
    if (!o.status) return "kept";
    status = await o.status(op);
  } catch {
    await o.log(`[claude-rc] Cannot verify bridge evidence for op ${op}; checkpoint retained, no replay\n`);
    return "kept";
  }
  if (status !== null || prev.dispatchMode !== "prepared") {
    await o.log(`[claude-rc] Unsettled op ${op} (issue ${prev.issueId ?? "?"}); checkpoint retained for receipt/block or operator reconciliation; no replay\n`);
    return "kept";
  }
  if (await o.live(prev.conversationId ?? null) || !(await o.paneIdle())) return "kept";
  const dest = path.join(o.stateDir, `active.never-submitted-${op}.json`);
  await fs.rename(o.activePath, dest);
  await o.log(`[claude-rc] Archived never-submitted op ${op} at ${dest}; seat freed\n`);
  return "archived";
}

const AGENT_TMP_ROOT = "/Volumes/NVM/AI_Agent_Runtime/tmp";
function agentTmpDir(session: string): string { return path.join(AGENT_TMP_ROOT, `claude-rc-${session}`); }

/** SCO-534: agent work never runs from / or a hidden/system temp directory. */
export function assertWorkableCwd(cwd: string): void {
  if (cwd === "/" || cwd.startsWith("/private/var/folders") || cwd.startsWith("/var/folders") || /(^|\/)\.[^/.]/.test(cwd))
    throw new Error(`claude_rc_local cwd ${cwd} is root, system temp or hidden; use a canonical NVM path (SCO-534)`);
}

/** SCO-560 (opt-in keepConversation): reuse the live conversation instead of /clear.
 * keepConversationAcrossProjects: a cross-project seat (Board) keeps one conversation
 * whatever project the next issue is in; compaction, not /clear, bounds its size. */
export interface KeepState {
  conversationId: string; projectId: string; issueIds?: string[];
  /** SCO-756: managed goal key this conversation last received, per issue. */
  goalKeys?: Record<string, string>;
}

/** SCO-756: the managed goal with the key this kept conversation already holds for the issue. */
export function goalForConversation(goal: unknown, reuse: boolean, state: KeepState | null, issueId: string): unknown {
  if (!goal || typeof goal !== "object") return goal;
  return { ...(goal as Record<string, unknown>), deliveredKey: reuse ? state?.goalKeys?.[issueId] ?? null : null };
}
export const PROMPT_BUDGET = 50_000;
/** Bound context before the token firewall, including fresh prompts rebuilt after rotation. */
export async function assembleDispatchPrompt(sections: string[], seat: string, model: string, share?: number): Promise<string> {
  const prompt = joinPromptSections(fitPromptSections(sections, [2, 3], joinPromptSections));
  await assertAssembledPrompt({ seat, model, prompt, share });
  if (prompt.length > PROMPT_BUDGET) throw new Error("Claude prompt exceeds dispatch budget");
  return prompt;
}
/** Shrink the largest trimmable section until the joined prompt fits; a long task history must not fail the wake. */
export function fitPromptSections(sections: string[], trimmable: number[], join: (s: string[]) => string, budget = PROMPT_BUDGET): string[] {
  const out = [...sections];
  const marker = (n: number) => `\n\n[paperclip] ${n} chars of this section omitted to fit the dispatch budget; fetch the issue thread and documents for anything you need.\n\n`;
  for (let i = 0; i < 4 && join(out).length > budget; i++) {
    const idx = trimmable.reduce((a, b) => (out[b].length > out[a].length ? b : a));
    const over = join(out).length - budget;
    const s = out[idx];
    const cut = Math.min(s.length, over + 400);
    if (cut <= 0) break;
    const head = Math.floor((s.length - cut) * 0.6);
    out[idx] = s.slice(0, head) + marker(cut) + s.slice(head + cut);
  }
  return out;
}
export function shouldReuseConversation(o: {
  enabled: boolean; state: KeepState | null; newestId: string | null; projectId: string;
  sizeBytes: number; maxBytes: number; acrossProjects?: boolean;
  busy?: boolean;
}): boolean {
  return !!o.newestId && (o.busy === true || (o.enabled && !!o.state && o.state.conversationId === o.newestId
    && (o.acrossProjects === true || o.state.projectId === o.projectId) && o.sizeBytes < o.maxBytes));
}

/** SCO-693: true when the TUI's working folder is not the configured cwd (symlinks resolved). */
export async function paneCwdDiffers(panePath: string, cwd: string): Promise<boolean> {
  if (!panePath) return false;
  const real = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));
  return (await real(panePath)) !== (await real(cwd));
}

async function ensureSession(
  socket: string, session: string, cwd: string, stateDir: string,
  name: string, model: string, effort: string, channel: ChannelHost, rejoinOnly: boolean, keepConversation = false,
): Promise<{ rcUrl: string; cwd: string }> {
  let sessionCwd = cwd;
  let exists = true;
  try { await tmux(socket, ["has-session", ...target(session)]); } catch { exists = false; }
  // SCO-693: a changed adapterConfig.cwd must take effect. A non-keepConversation seat holds no state
  // worth keeping between wakes, so at an idle boundary recreate its TUI in the new cwd.
  if (exists && !rejoinOnly && !keepConversation) {
    const panePath = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_path}"]).catch(() => "")).trim();
    if (await paneCwdDiffers(panePath, cwd)) {
      if (isClaudeIdle(await claudePane(socket, session))) {
        const proc = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_command}"])).trim();
        if (proc !== "claude") throw new Error(`tmux pane is ${proc}, not claude; refusing to commandeer it`);
        await tmux(socket, ["kill-session", ...target(session)]);
        exists = false;
      } else {
        // Keep live work in its actual cwd for this wake; never wait or kill it.
        sessionCwd = panePath;
      }
    }
  }
  if (!exists) {
    if (rejoinOnly) {
      throw new Error("Claude active op lost its original TUI; hold for operator reconciliation, never replay");
    }
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(agentTmpDir(session), { recursive: true });
    // [ASSUMPTION] The experimental channel flag remains accepted by Claude
    // Code 2.1.x; it is hidden in some versions of --help. Live verify before use.
    // No --strict-mcp-config: that would hide the owner's other required MCPs.
    await tmux(socket, ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", cwd,
      "-e", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
      // SCO-534: scratch on NVM per agent, never the per-user /var/folders temp.
      "-e", `TMPDIR=${agentTmpDir(session)}`,
      CLAUDE, "--remote-control", name, "--name", name, "--model", model, "--effort", effort,
      "--dangerously-skip-permissions",
      "--mcp-config", channel.mcpConfigPath,
      "--settings", channel.hookSettingsPath,
      "--dangerously-load-development-channels", `server:${CHANNEL_NAME}`]);
  }
  const processName = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_command}"])).trim();
  if (processName !== "claude") throw new Error(`tmux pane is ${processName}, not claude; refusing to commandeer it`);
  // Single checks, including existing seats: neither check waits for an idle turn.
  const screen = await claudePane(socket, session);
  if (/trust the files|Do you trust/i.test(screen))
    throw new Error("Claude workspace trust prompt: approve this dedicated workspace in the terminal, then retry");
  if (isDevChannelPrompt(screen)) await tmux(socket, ["send-keys", ...target(session), "Enter"]);
  const urlFile = path.join(stateDir, "remote-control-url.txt");
  // The RC URL can render after startup; wait only for that identity signal.
  let url: string | null = null;
  for (const until = Date.now() + 15_000; ;) {
    url = parseClaudeRcUrl(await claudePane(socket, session).catch(() => ""));
    if (url || Date.now() >= until) break;
    await sleep(750);
  }
  if (url) await fs.writeFile(urlFile, url + "\n", { mode: 0o600 });
  return { rcUrl: url ?? (exists ? (await fs.readFile(urlFile, "utf8").catch(() => "")).trim() : ""), cwd: sessionCwd };
}

/** Terminal `block` the worker recorded via pcbridge paperclip_block for this op, if any. */
async function readBlockTerminal(stateDir: string, opId: string): Promise<string | null> {
  const raw = await fs.readFile(path.join(stateDir, "channel-bridge", "ledger.jsonl"), "utf8").catch(() => "");
  for (const line of raw.split("\n").reverse()) {
    if (!line.includes(opId) || !line.includes('"terminal"')) continue;
    try {
      const ev = JSON.parse(line) as { ev?: string; op_id?: string; kind?: string; reason?: string };
      if (ev.ev === "terminal" && ev.op_id === opId && ev.kind === "block") return asString(ev.reason, "blocked");
    } catch { /* partial line */ }
  }
  return null;
}

/** Post the worker's blocker as a comment and mark the issue blocked, under the run-scoped token. */
async function deliverBlock(ctx: AdapterExecutionContext, issueId: string, reason: string, stateDir: string, sourceRunId: string): Promise<void> {
  await settleOutcome(ctx, stateDir, sourceRunId, issueId, { kind: "block", reason });
}

async function postComment(ctx: AdapterExecutionContext, issueId: string, body: string): Promise<void> {
  if (!ctx.authToken) return;
  const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
  await fetch(new URL(`/api/issues/${encodeURIComponent(issueId)}/comments`, `http://127.0.0.1:${port}`), {
    method: "POST", redirect: "manual", body: JSON.stringify({ body }), signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId, "Content-Type": "application/json" },
  });
}

async function derivedRcName(ctx: AdapterExecutionContext): Promise<string> {
  let depth = 0;
  try {
    if (ctx.authToken) {
      const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
      const res = await fetch(new URL(`/api/companies/${encodeURIComponent(ctx.agent.companyId)}/agents`, `http://127.0.0.1:${port}`), {
        redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${ctx.authToken}`, "X-Paperclip-Run-Id": ctx.runId },
      });
      if (res.ok) depth = reportsToDepth(ctx.agent.id, (await res.json()) as RcAgentNode[]);
      else await ctx.onLog("stderr", `[claude-rc] RC name depth lookup HTTP ${res.status}; using depth 0\n`);
    }
  } catch (e) {
    await ctx.onLog("stderr", `[claude-rc] RC name depth lookup failed (${(e as Error).message}); using depth 0\n`);
  }
  const name = deriveRcName(ctx.agent.name, depth);
  const configured = typeof ctx.config.remoteControlName === "string" ? ctx.config.remoteControlName.trim() : "";
  if (configured && sanitizeRcName(configured) !== name)
    await ctx.onLog("stdout", `[claude-rc] Ignoring configured remoteControlName "${configured}"; Remote Control name is derived: "${name}"\n`);
  return name;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = ctx.config;
  const baseSession = asString(cfg.tmuxSession, "claude");
  let session = baseSession;
  const socket = asString(cfg.tmuxSocket, "pc-claude-rc");
  // SCO-782: derived from agent name + reportsTo depth; any configured remoteControlName is ignored.
  let name = await derivedRcName(ctx);
  const baseStateDir = path.resolve(asString(cfg.stateDir, path.join(os.homedir(), ".paperclip/claude-rc-state")));
  let stateDir = baseStateDir;
  // SCO-965: `slots` seats (default 1); slot 0 is the configured seat, others are <session>-s<k> with own state dir.
  const slots = Array.from({ length: rcSlotCount(cfg.slots) }, (_, i) => rcSlot(i, baseSession, baseStateDir));
  let slotIndex = 0;
  let cwd = path.resolve(asString(cfg.cwd, "/Volumes/NVM/Paperclip/workspaces/claude-rc"));
  const model = asString(cfg.model, "claude-sonnet-5-5");
  const effort = asString(cfg.effort, "medium");
  const issueId = asString(ctx.context.issueId, asString(ctx.context.taskId, ""));
  const timeoutMs = Math.min(3600, Math.max(30, Number(cfg.timeoutSec) || 900)) * 1000;
  let unlock: (() => Promise<void>) | undefined;
  let runEnvPath: string | undefined;
  let dispatched = false;
  const failure = (reason: string, timedOut = false): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut, model, provider: "anthropic", biller: "anthropic",
    billingType: "subscription", costStatus: "unpriced", errorMessage: reason,
    ...(!dispatched && isTargetBusyRefusal(reason) ? { errorFamily: "target_busy" as const } : {}),
    ...(dispatched ? {} : { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } }),
  });
  try {
    if (!MODELS.has(model)) throw new Error(`claude_rc_local permits only ${[...MODELS].join(", ")}; received ${model}`);
    if (!EFFORTS.has(effort)) throw new Error(`invalid effort ${effort}`);
    assertWorkableCwd(cwd);
    if (!ID.test(socket) || !slots.every(slot => ID.test(slot.session))) throw new Error("invalid tmux socket/session/name");
    if (!issueId) return {
      exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model,
      billingType: "subscription", costStatus: "unpriced", summary: "claude_rc_local: no issue on this wake; nothing to dispatch",
    };
    if (!ctx.authToken) throw new Error("claude_rc_local requires a Paperclip run-scoped token before dispatch");
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== "local")
      throw new Error("claude_rc_local runs on the Mac Pro local host only");
    await fs.mkdir(baseStateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(baseStateDir, 0o700);
    const claimed = await claimSlot(ctx, slots, issueId, Date.now() + timeoutMs);
    unlock = claimed.unlock;
    ({ session, stateDir } = claimed.slot);
    slotIndex = claimed.slot.index;
    if (slotIndex > 0) {
      await fs.chmod(stateDir, 0o700);
      name = slotRcName(name, slotIndex);
    }
    if (slots.length > 1) await ctx.onLog("stdout", `[claude-rc] seat ${slotIndex + 1}/${slots.length}: tmux ${socket}/${session}\n`);
    const activePath = path.join(stateDir, "active.json");
    // F07: do not replace the original run's environment or touch its transport
    // until a foreign checkpoint is durably settled under its own issue scope.
    await reconcileForeignSettlement(ctx, stateDir, activePath);
    // SCO-653: run-scoped write path for the pane. 0600 file read only by bin/pcrc; never printed.
    const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
    const callbackUrl = asString(process.env.PAPERCLIP_PUBLIC_URL,
      asString(process.env.PAPERCLIP_API_URL, `http://127.0.0.1:${port}`));
    const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    runEnvPath = path.join(stateDir, "run-env.sh");
    await fs.writeFile(runEnvPath, [
      `export PAPERCLIP_API_URL=${sq(callbackUrl)}`,
      `export PAPERCLIP_API_KEY=${sq(ctx.authToken)}`,
      `export PAPERCLIP_RUN_ID=${sq(ctx.runId)}`,
      `export PAPERCLIP_TASK_ID=${sq(issueId)}`, ""].join("\n"), { mode: 0o600 });
    await fs.chmod(runEnvPath, 0o600);
    const bridgeRoot = await findBridgeRoot(asString(cfg.channelBridgeRoot, "") || undefined);
    const channel = await prepareChannelHost(stateDir, bridgeRoot);
    // SCO-980: inspect delivery evidence before permitting a new operation ID.
    await reconcileOrphanActive({
      stateDir, activePath, issueId, runId: ctx.runId,
      status: channel.status,
      live: async (conv) => {
        if (!conv) return false;
        const st = await fs.stat(path.join(projectDir(cwd), `${conv}.jsonl`)).catch(() => null);
        return Boolean(st) && Date.now() - st!.mtimeMs < (Number(cfg.liveWindowSec) || 600) * 1000;
      },
      paneIdle: async () => isClaudeIdle(await claudePane(socket, session)),
      log: (m) => ctx.onLog("stdout", m),
    });
    const adopted = adoptableActive(await fs.readFile(activePath, "utf8").catch(() => ""), issueId, stateDir, "claude_rc_local");
    const adoptedCwd = (adopted as { cwd?: unknown } | null)?.cwd;
    if (typeof adoptedCwd === "string" && path.isAbsolute(adoptedCwd)) {
      assertWorkableCwd(adoptedCwd);
      cwd = adoptedCwd;
    }
    const ensured = await ensureSession(socket, session, cwd, stateDir, name, model, effort, channel, Boolean(adopted), cfg.keepConversation === true);
    const rcUrl = ensured.rcUrl;
    cwd = ensured.cwd;
    if (!rcUrl) throw new Error("Claude RC URL unavailable; refusing to dispatch to an unverified session");
    // Owner 2026-11-03: auto re-pin, logged. The URL comes from the owned tmux
    // pane verified above; an adopted in-flight op still requires an exact match.
    const pinPath = path.join(stateDir, "rc-url.json");
    const pinned = await fs.readFile(pinPath, "utf8").then(t => asString(JSON.parse(t)?.url, "")).catch(() => "")
      || (slotIndex === 0 ? asString(cfg.expectedRemoteControlUrl, rcUrl) : rcUrl);
    if (pinned !== rcUrl)
      await ctx.onLog("stdout", `[claude-rc] RC URL re-pinned ${pinned} -> ${rcUrl} (owned tmux ${socket}/${session})\n`);
    if (pinned !== rcUrl || !(await fs.stat(pinPath).catch(() => null)))
      await fs.writeFile(pinPath, JSON.stringify({ url: rcUrl, previous: pinned === rcUrl ? null : pinned,
        at: new Date().toISOString(), runId: ctx.runId }), { mode: 0o600 });
    let receiptRunId = ctx.runId;
    let receiptPath = receiptFilePath(stateDir, ctx.runId);
    let conversationId: string | null = null;

    if (adopted) {
      if (adopted.rcUrl !== rcUrl) throw new Error("Claude RC URL changed since adopted dispatch; operator reconciliation required");
      receiptRunId = adopted.runId;
      receiptPath = adopted.receiptPath;
      conversationId = adopted.conversationId ?? null;
      // Does not consult/modify the inbox. Even an emitted-local or pending
      // op is UNKNOWN until a receipt. Never try to re-enqueue on restart.
      const adoptedOpId = (adopted as { op_id?: string }).op_id || adopted.runId;
      await routeChannelInput(adoptedOpId, "", true, {
        ready: channel.ready, status: channel.status, submit: channel.submit,
        ...((adopted as { dispatchMode?: string }).dispatchMode === "channel-pending"
          ? { observe: () => channel.observeInput(adoptedOpId, receiptPath, ctx.signal) } : {}),
        fallback: async () => { throw new Error("adoption may never paste"); },
      });
      ctx.onDispatch?.();
      dispatched = true;
      await ctx.onLog("stdout", `[claude-rc] Adopting run ${adopted.runId} for issue ${issueId}; no re-dispatch; receipt ${receiptPath}\n`);
    } else {
      const keepPath = path.join(stateDir, "keep-conversation.json");
      const keepEnabled = cfg.keepConversation === true;
      const projectId = asString(ctx.context.projectId, "");
      const keepMax = typeof cfg.keepConversationMaxBytes === "number" ? cfg.keepConversationMaxBytes : 400_000;
      const keepState: KeepState | null = keepEnabled
        ? await fs.readFile(keepPath, "utf8").then(t => JSON.parse(t) as KeepState).catch(() => null) : null;
      const before = await seatConversation(session, cwd) ?? (slots.length === 1 ? await newestConversation(cwd) : null);
      const keepSize = before ? (await fs.stat(path.join(projectDir(cwd), `${before}.jsonl`)).catch(() => null))?.size ?? 0 : 0;
      let reuse = shouldReuseConversation({
        enabled: keepEnabled, state: keepState, newestId: before, projectId, sizeBytes: keepSize, maxBytes: keepMax,
        acrossProjects: cfg.keepConversationAcrossProjects === true,
        busy: !isClaudeIdle(await claudePane(socket, session)),
      });
      if (reuse) {
        conversationId = before;
      }
      const buildDispatchPrompt = async () => {
      const promptBase = asString(cfg.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
      // A kept conversation already holds the standing text (template, run rules, receipt format)
      // and the brief and history of every issue it handled, so a wake resends only the delta,
      // as claude_local does on --resume. An issue new to the conversation still gets its brief.
      const knownConversation = reuse && keepState?.conversationId === before;
      const seenIssueIds = knownConversation ? keepState?.issueIds ?? [] : [];
      const seenIssue = seenIssueIds.includes(issueId);
      const wake = ctx.context.paperclipWake;
      const goal = goalForConversation(ctx.context.paperclipRunnerGoal, knownConversation, keepState, issueId);
      const promptContext = {
        ...ctx.context,
        ...(goal ? { paperclipRunnerGoal: goal } : {}),
        ...(seenIssue && wake && typeof wake === "object"
          ? { paperclipWake: { ...(wake as Record<string, unknown>), continuationSummary: null } } : {}),
      };
      const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(promptContext, { resumedSession: seenIssue });
      const instructionsFilePath = asString(cfg.instructionsFilePath, "");
      const instructionsFull = instructionsFilePath ? await fs.readFile(instructionsFilePath, "utf8") : "";
      const instructionsPrefix = knownConversation ? "" : instructionsFull;
      const intro = knownConversation ? "" : renderTemplate(promptBase, {
        agent: ctx.agent, run: { id: ctx.runId }, context: ctx.context, companyId: ctx.agent.companyId,
      });
      const promptStateDir = await readableRuntimePath(ctx, "rc", stateDir);
      const promptReceiptPath = path.join(promptStateDir, path.basename(receiptPath));
      const promptRunEnvPath = path.join(promptStateDir, path.basename(runEnvPath!));
      const instructions = knownConversation ? [
        `Paperclip run ${ctx.runId}, issue ${issueId}: work on ONLY this issue; standing run rules unchanged.`,
        `Done receipt (Write tool, only on success; do not update the issue yourself): ${promptReceiptPath} with keys runId, issueId,`,
        'status "done", summary, report (Markdown, 250+ chars).',
        `pcrc: PAPERCLIP_RC_RUN_ENV=${promptRunEnvPath}.`,
      ].join(" ") : [
        `Paperclip run ${ctx.runId}, issue ${issueId}. Work on ONLY the assigned issue.`,
        "This is the owner's live Claude Code Remote Control session: messages they send mid-task steer this issue.",
        "Run every command in the foreground; never background a tool call. Never print secrets or guess Paperclip API credentials.",
        `To comment or edit this issue (e.g. blockedByIssueIds) prefix the shared api command: PAPERCLIP_RC_RUN_ENV=${promptRunEnvPath} pcrc api POST ./comments '{"body":"..."}' or ... pcrc api PATCH . '{"blockedByIssueIds":[]}'. pcrc supplies the run-scoped credentials; never print them.`,
        "Finish the requested issue work, then use your Write tool to create the JSON receipt",
        `${promptReceiptPath} with exactly these keys: runId = ${ctx.runId}, issueId = ${issueId},`,
        'status = "done", summary = a short factual summary, report = a detailed Markdown result (at least 250 characters).',
        "Write it only once actual work is complete. The Paperclip adapter publishes the report and closes the issue",
        "under the run's scoped identity. Do NOT update the issue yourself. Do not write a done receipt on failure;",
        "if blocked, explain the blocker visibly and stop.",
      ].join(" ");
      // The channel preserves Markdown/newlines; only the tmux fallback flattens.
      const sections = [instructionsPrefix, intro, taskContextNote, wakePrompt,
        asString(ctx.context.paperclipSessionHandoffMarkdown, ""), instructions];
      const prompt = await assembleDispatchPrompt(sections, ctx.agent.name, model,
        cfg.tokenPreflightShare === undefined ? undefined : Number(cfg.tokenPreflightShare));
      return { prompt, goal, seenIssueIds, knownConversation, instructionsFull };
      };
      let built = await buildDispatchPrompt();
      const gate = await preflightSessionPrompt(ctx, model, built.prompt, before);
      if (gate.rotate) {
        if (!isClaudeIdle(await claudePane(socket, session)))
          throw new Error(`Claude input guard refused context rotation while busy or owner input is present: ${gate.reason}`);
        applyPromptRotation(ctx, gate);
        reuse = false;
        built = await buildDispatchPrompt();
        await ctx.onLog("stderr", `[paperclip] Starting fresh: ${gate.reason}\n`);
      }
      const { prompt, goal, seenIssueIds, knownConversation, instructionsFull } = built;
      if (!reuse) {
        if (!isClaudeIdle(await claudePane(socket, session)))
          throw new Error("Claude input guard refused /clear while busy or owner input is present");
        await sendClaudePane(socket, session, "/clear", stateDir);
        // /clear is acknowledged by this seat's new conversation, even if busy.
        const clearDeadline = Date.now() + 12_000;
        do {
          conversationId = await seatConversation(session, cwd);
          if (conversationId && conversationId !== before) break;
          await sleep(500);
        } while (Date.now() < clearDeadline);
        if (!conversationId || conversationId === before)
          throw new Error("Claude /clear did not start an isolated conversation");
      }
      if (keepEnabled) {
        await ctx.onLog("stdout", `[claude-rc] keepConversation ${reuse ? "reuse" : "fresh"}: prompt ${prompt.length} bytes (instructions ${reuse ? 0 : instructionsFull.length} of ${instructionsFull.length}); conversation ${Math.round(keepSize)} bytes\n`);
        const issueIds = [...seenIssueIds.filter(id => id !== issueId), issueId].slice(-200);
        const goalKey = (goal as { key?: unknown } | undefined)?.key;
        const goalKeys = { ...(knownConversation ? keepState?.goalKeys ?? {} : {}) };
        if (typeof goalKey === "string") goalKeys[issueId] = goalKey;
        for (const id of Object.keys(goalKeys)) if (!issueIds.includes(id)) delete goalKeys[id];
        await fs.writeFile(keepPath, JSON.stringify({ conversationId, projectId, issueIds, goalKeys }), { mode: 0o600 });
      }
      // SCO-756: owner-guard's Stop gate maps this seat's conversation to its agent and managed goals.
      const seatPath = path.join(stateDir, "seat.json");
      const seat = await fs.readFile(seatPath, "utf8").then(t => JSON.parse(t) as { goals?: Record<string, string>; nativeGoalKey?: string | null }).catch(() => null);
      const goals = { ...(seat?.goals ?? {}) };
      const goalState = (goal as { state?: unknown } | undefined)?.state;
      if (typeof goalState === "string") goals[issueId] = goalState; else delete goals[issueId];
      for (const id of Object.keys(goals).slice(0, -200)) delete goals[id];
      // SCO-771: re-apply the native /goal the managed goal implies; a /clear or restart loses it.
      let nativeGoalKey = reuse ? seat?.nativeGoalKey ?? null : null;
      const goalObj = goal as { state?: string; objective?: string | null; key?: string } | undefined;
      const wantKey = goalObj?.state === "active" && goalObj.objective ? goalObj.key ?? null : null;
      if (wantKey && wantKey !== nativeGoalKey) {
        const cond = goalObj!.objective!.replace(/\s+/g, " ").trim().slice(0, 1500);
        if (await typeNativeGoal(socket, session, `/goal ${cond}`, /Goal set:|\/goal active/i)) nativeGoalKey = wantKey;
        else await ctx.onLog("stderr", `[claude-rc] native /goal not confirmed ("Goal set:" missing or input not empty) for ${issueId}\n`);
      } else if (!wantKey && nativeGoalKey) {
        if (await typeNativeGoal(socket, session, "/goal clear", /Goal cleared|No goal|cleared/i)) nativeGoalKey = null;
        else await ctx.onLog("stderr", `[claude-rc] native /goal clear not confirmed for ${issueId}\n`);
      }
      await fs.writeFile(seatPath, JSON.stringify({
        agentId: ctx.agent.id, companyId: ctx.agent.companyId, cwd, conversationId, goals, nativeGoalKey,
      }), { mode: 0o600 });
      const active: Record<string, unknown> = {
        runId: ctx.runId, issueId, op_id: ctx.runId, receiptPath, rcUrl,
        tmuxSocket: socket, tmuxSession: session, conversationId, cwd,
        dispatchMode: "prepared", startedAt: new Date().toISOString(),
        doneGateBaseline: await captureDoneGateBaseline(ctx.runId, productionDeps()),
      };
      // Exact checkpoint, durable before any potentially side-effecting emit.
      await writeCheckpoint(activePath, JSON.stringify(active, null, 2), "wx");
      ctx.onDispatch?.();
      dispatched = true;
      await ctx.onLog("stdout", `[claude-rc] Dispatching issue ${issueId} via MCP channel ${CHANNEL_NAME}; conversation ${conversationId}; receipt ${receiptPath}\n`);
      const mode = await routeChannelInput(ctx.runId, prompt, false, {
        ready: channel.ready, status: channel.status,
        observe: () => channel.observeInput(ctx.runId, receiptPath, ctx.signal),
        submit: async (opId, input) => {
          await recordDispatchMode(activePath, active, "channel-pending");
          return channel.submit(opId, input);
        },
        fallback: async () => {
          if (!isPromptEmpty(await claudePane(socket, session))) {
            throw new Error("channel unavailable and Claude editor is not empty; no fallback");
          }
          await recordDispatchMode(activePath, active, "tmux-fallback");
          await ctx.onLog("stderr", "[claude-rc] Channel unavailable; using guarded tmux fallback (no bridge op submitted)\n");
          await sendClaudePane(socket, session, normalizeOneLine(prompt), stateDir);
        },
      });
      await ctx.onLog("stdout", `[claude-rc] Input route ${mode}; op_id ${ctx.runId}\n`);
    }
    let deadline = Date.now() + timeoutMs;
    // A conversation still writing its transcript is working, not hung: slide the deadline
    // while the jsonl is fresh, up to a hard cap, instead of orphaning it (SCO-564).
    const hardDeadline = Date.now() + Math.max(timeoutMs, (Number(cfg.maxExtendSec) || 4 * 3600) * 1000);
    const liveWindowMs = (Number(cfg.liveWindowSec) || 600) * 1000;
    const conversationLive = async () => {
      if (!conversationId) return false;
      const st = await fs.stat(path.join(projectDir(cwd), `${conversationId}.jsonl`)).catch(() => null);
      return Boolean(st) && Date.now() - st!.mtimeMs < liveWindowMs;
    };
    let receipt: Receipt | null = null;
    let idleWithoutReceipt = 0;
    let gateRefusals = 0;
    let blockedReason = null as string | null;
    while (true) {
      if (Date.now() >= deadline) {
        if (Date.now() < hardDeadline && await conversationLive()) {
          deadline = Math.min(Date.now() + timeoutMs, hardDeadline);
          await ctx.onLog("stdout", `[claude-rc] timeout reached but conversation ${conversationId} is still writing; extending deadline\n`);
        } else break;
      }
      if (ctx.signal?.aborted) throw new Error("Claude run cancelled; shared TUI left intact, active checkpoint preserved");
      const raw = await fs.readFile(receiptPath, "utf8").catch(() => "");
      if (raw) {
        receipt = parseReceipt(raw, receiptRunId, issueId);
        // Delivered work waiting on review must not be refused/restarted by a
        // later source-tree change. Settlement below only observes review state.
        if (await isReviewContinuation(ctx, stateDir, receiptRunId, issueId, receipt)) break;
        // SCO-762 done gate: canonical-repo edits need committed SHAs on main (live or queued for autodeploy).
        const checkpoint = await fs.readFile(activePath, "utf8").then(t => JSON.parse(t) as { startedAt?: string; doneGateBaseline?: GateBaseline });
        const startedAt = Date.parse(asString(checkpoint.startedAt, ""));
        // Adoption retains the original dispatch baseline; never recapture at completion.
        const gate = await gateReceiptRaw(raw, conversationId ? path.join(projectDir(cwd), `${conversationId}.jsonl`) : null, Number.isFinite(startedAt) ? startedAt : 0, productionDeps(), checkpoint.doneGateBaseline);
        if (!gate.ok) {
          gateRefusals += 1;
          receipt = null;
          await fs.rename(receiptPath, `${receiptPath}.refused-${gateRefusals}`).catch(() => {});
          await ctx.onLog("stdout", `[claude-rc] Done gate refused receipt ${gateRefusals}/3 for ${issueId}: ${gate.reasons.join(" | ").slice(0, 600)}\n`);
          if (gateRefusals >= 3) {
            blockedReason = `done gate refused 3 receipts: ${gate.reasons.join(" | ").slice(0, 1500)}`;
            await deliverBlock(ctx, issueId, blockedReason, stateDir, receiptRunId);
            await fs.rm(activePath, { force: true });
            break;
          }
          await sendClaudePane(socket, session, normalizeOneLine(refusalMessage(gate.reasons, gateRefusals, 3)), stateDir);
          await sleep(1100);
          continue;
        }
        break;
      } else if (await readBlockTerminal(stateDir, receiptRunId).then(async reason => {
        if (reason === null) return false;
        await deliverBlock(ctx, issueId, reason, stateDir, receiptRunId);
        await ctx.onLog("stdout", `[claude-rc] Worker blocked ${issueId}: ${reason.slice(0, 200)}\n`);
        await fs.rm(activePath, { force: true });
        blockedReason = reason;
        return true;
      })) {
        break;
      } else if (adopted) {
        idleWithoutReceipt = isClaudeIdle(await claudePane(socket, session)) ? idleWithoutReceipt + 1 : 0;
        if (idleWithoutReceipt >= 5)
          return failure("Claude adopted dispatch idle without a receipt; checkpoint retained for reconciliation");
      }
      await tmux(socket, ["has-session", ...target(session)]);
      await sleep(1100);
    }
    if (blockedReason !== null) return {
      exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model,
      billingType: "subscription", costStatus: "unpriced", summary: `Blocked: ${blockedReason.split("\n")[0].slice(0, 200)}`,
      sessionId: conversationId, sessionDisplayId: conversationId,
      sessionParams: { sessionId: conversationId, cwd, remoteControlUrl: rcUrl, remoteControlName: name, tmuxSocket: socket, tmuxSession: session },
      resultJson: { issueId, receiptPath, remoteControlUrl: rcUrl, conversationId, blocked: true },
    };
    if (!receipt && await conversationLive()) {
      await postComment(ctx, issueId, `claude_rc run ${ctx.runId} timed out, but RC conversation ${conversationId} is still writing its transcript (${rcUrl}). It is likely still working; its later receipt at ${receiptPath} can be recovered. Do not re-dispatch.`).catch(() => {});
    }
    if (!receipt)
      return failure("Claude did not produce a validated completion receipt; checkpoint retained", true);
    const disposition = await settleOutcome(ctx, stateDir, receiptRunId, issueId, { kind: "done", receipt });
    const issueClosed = disposition.status === "done";
    await ctx.onLog("stdout", `[claude-rc] ${issueClosed ? "Done" : "Awaiting review"} ${issueId}: ${receipt.summary}; conversation=${conversationId ?? "unknown"}\n`);
    if (issueClosed) await fs.rm(activePath);
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "anthropic", biller: "anthropic", model,
      billingType: "subscription", costStatus: "unpriced", summary: receipt.summary,
      sessionId: conversationId, sessionDisplayId: conversationId,
      sessionParams: {
        sessionId: conversationId, cwd, remoteControlUrl: rcUrl,
        remoteControlName: name, tmuxSocket: socket, tmuxSession: session,
      },
      resultJson: { issueId, receiptPath, remoteControlUrl: rcUrl, conversationId, reportPublished: true,
        issueClosed, issueStatus: disposition.status, reviewPending: !issueClosed },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await ctx.onLog("stderr", `[claude-rc] ${error}\n`);
    return failure(error);
  } finally {
    if (runEnvPath) await fs.rm(runEnvPath, { force: true });
    if (unlock) await unlock();
  }
}
