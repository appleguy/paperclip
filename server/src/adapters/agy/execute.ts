/**
 * Paperclip -> one long-lived Antigravity TUI Remote Control instance.
 * agy 1.4.x has no supported daemon injection protocol; the tmux pane is
 * the *same* interactive process users see and steer at the stable /r/ URL.
 * Runs are serialized per seat; Gemini agents may run `slots` seats (SCO-991), each its own tmux session.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { readableRuntimePath } from "@paperclipai/adapter-utils/readable-runtime-paths";
import { parseHeartbeatPolicy } from "../../services/heartbeat/timer-policy.js";
import { AGY_HOST_ADMISSION, claimAgyHostAdmission, isAgyAdmissionIdle, isAgyHostLimitedModel } from "./admission.js";
import { assertAssembledPrompt, preflightSessionPrompt, applyPromptRotation } from "@paperclipai/adapter-utils/token-preflight";
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
/** Pre-dispatch refusals meaning the seat is occupied: the wake waits instead of failing. */
export function isTargetBusyRefusal(reason: string): boolean {
  return /previous task unresolved|Claude TUI not idle|RC URL changed; refusing to dispatch to an unverified session|input guard refused|Remote Control seats? busy|single Remote Control session busy/i.test(reason);
}

/** A released process mutex alone does not prove that its provider run has stopped. */
export async function checkpointRunState(
  ctx: AdapterExecutionContext, raw: string,
): Promise<"empty" | "self" | "live" | "terminal" | "unknown"> {
  if (!raw) return "empty";
  let active: Partial<ActiveDispatch>;
  try { active = JSON.parse(raw); } catch { return "unknown"; }
  if (!active || typeof active.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(active.runId)
      || typeof active.issueId !== "string") return "unknown";
  if (active.runId === ctx.runId) return "self";
  if (!ctx.authToken) return "unknown";
  const port = Number(process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "unknown";
  try {
    // At most one bounded read per checkpointed seat in this claim. No idle polling.
    const response = await fetch(`http://127.0.0.1:${port}/api/heartbeat-runs/${encodeURIComponent(active.runId)}`, {
      redirect: "manual", signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${ctx.authToken}` },
    });
    if (!response.ok) return "unknown";
    const run = await response.json() as { id?: unknown; agentId?: unknown; companyId?: unknown; status?: unknown; contextSnapshot?: { issueId?: unknown; taskId?: unknown } };
    if (run?.id !== active.runId || run.agentId !== ctx.agent.id || run.companyId !== ctx.agent.companyId
        || (run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== active.issueId) return "unknown";
    if (run.status === "queued" || run.status === "running") return "live";
    return ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(run.status)) ? "terminal" : "unknown";
  } catch { return "unknown"; }
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
  // Running background tasks add another bordered strip beneath the editor.
  for (let i = borders.length - 1; i > 0; i--) {
    const bottom = borders[i]!;
    const top = borders[i - 1]!;
    if (lines.length - bottom > 10) return false;
    const editor = lines.slice(top + 1, bottom).filter(line => line.trim() !== "");
    if (!/^\s*>/.test(editor[0] ?? "")) continue;
    return editor.length === 1 && /^\s*>\s*$/.test(editor[0]!);
  }
  return false;
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
  contextTokens?: number | null;
};
/** Owner 2026-11-04: every agent defaults to a 200k max context. agy's CLI has no working threshold setting
 *  (`contextWindow` is accepted but ignored; window stays 1M), so the adapter compacts when usage passes this. */
export const AGY_CONTEXT_LIMIT_TOKENS = 200_000;
export const AGY_COMPACT_PROMPT = "/compact Continue the assigned issue work from the summary; write the receipt once work is complete.";
export function needsCompaction(snapshot: unknown, limit = AGY_CONTEXT_LIMIT_TOKENS): boolean {
  const t = (snapshot as Partial<AgyStatusLineSnapshot> | null)?.contextTokens;
  return typeof t === "number" && Number.isSafeInteger(t) && t > limit;
}

/**
 * Only the current editor protects owner typing. Working/tool-use markers,
 * queued input and status-line freshness do not gate delivery.
 */
export function inputGuard(
  screen: string,
): { allowed: boolean; reason: string } {
  return isEmptyInputBox(screen)
    ? { allowed: true, reason: "empty input editor" }
    : { allowed: false, reason: "TUI input is nonempty or not recognizable" };
}
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

export function receiptFilePath(stateDir: string, runId: string): string {
  return path.join(stateDir, `receipt-${runId.replaceAll("-", "").slice(0, 12)}.json`);
}

function validReceiptPath(stateDir: string, runId: string, candidate: unknown): candidate is string {
  return candidate === receiptFilePath(stateDir, runId) || candidate === path.join(stateDir, `receipt-${runId}.json`);
}
/**
 * Crash reconciliation without replay: a checkpoint for the SAME issue is
 * adopted by the next run (the TUI kept working while Paperclip restarted);
 * a checkpoint for any other issue still refuses dispatch.
 */
export function adoptableActive(raw: string, issueId: string, stateDir: string, adapter = "agy"): ActiveDispatch | null {
  if (!raw) return null;
  let a: Partial<ActiveDispatch>;
  try { a = JSON.parse(raw) as Partial<ActiveDispatch>; } catch { a = {}; }
  if (a.issueId !== issueId || typeof a.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(a.runId)
      || !validReceiptPath(stateDir, a.runId, a.receiptPath) || typeof a.rcUrl !== "string") {
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
// "=name:" is an exact session match. A bare name also matches a window named "agy" in the most recent session,
// so seat 1 commands would land in seat 2 (SCO-991).
export const target = (session: string) => ["-t", `=${session}:`];
export async function pane(socket: string, session: string): Promise<string> {
  return tmux(socket, ["capture-pane", ...target(session), "-p", "-J", "-S", "-150"]);
}
async function readStatusSnapshot(stateDir: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(path.join(stateDir, "status-line.json"), "utf8")); } catch { return null; }
}
async function inputReadiness(
  socket: string, session: string,
): Promise<{ allowed: boolean; reason: string }> {
  return inputGuard(await pane(socket, session));
}

export async function send(
  socket: string, session: string, message: string, stateDir: string,
): Promise<void> {
  if (/[\r\n]/.test(message)) throw new Error("multiline TUI submissions forbidden");
  const readiness = await inputReadiness(socket, session);
  if (!readiness.allowed) throw new Error(`agy input guard refused: ${readiness.reason}`);
  await pasteSubmit(socket, session, message, stateDir);
}

/** One-line bracketed paste + Enter. Callers own their editor-text guard. */
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

const AGENT_TMP_ROOT = "/Volumes/NVM/AI_Agent_Runtime/tmp";
function agentTmpDir(socket: string, session: string): string { return path.join(AGENT_TMP_ROOT, `agy-${socket}-${session}`); }

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
    await fs.mkdir(agentTmpDir(socket, session), { recursive: true });
    // tmux exec mode: no interpolated shell source or arbitrary model selection.
    await tmux(socket, ["new-session", "-d", "-s", session, "-c", cwd,
      "-e", `TMPDIR=${agentTmpDir(socket, session)}`,
      AGY, "--remote-control", "--dangerously-skip-permissions", "--model", model]);
  }
  const processName = (await tmux(socket, ["display-message", "-p", ...target(session), "#{pane_current_command}"])).trim();
  if (processName !== "agy") throw new Error(`tmux pane is ${processName}, not agy; refusing to commandeer it`);
  let screen = await pane(socket, session);
  // A freshly launched seat prints its RC URL and empty editor only after start-up.
  for (const until = Date.now() + 45_000; !exists && Date.now() < until
      && !/Do you trust the contents/.test(screen) && !(parseRemoteUrl(screen) && isEmptyInputBox(screen));) {
    await sleep(1000);
    screen = await pane(socket, session);
  }
  if (/Do you trust the contents/.test(screen))
    throw new Error("agy workspace trust prompt: approve this dedicated workspace in the terminal, then retry");
  if (!rejoinOnly) {
    const readiness = inputGuard(screen);
    if (!readiness.allowed) throw new Error(`agy input guard refused: ${readiness.reason}`);
  }
  const url = parseRemoteUrl(screen);
  if (url) await fs.writeFile(path.join(stateDir, "remote-control-url.txt"), url + "\n", { mode: 0o600 });
  const previous = await fs.readFile(path.join(stateDir, "remote-control-url.txt"), "utf8").catch(() => "");
  return url ?? (exists ? previous.trim() : "");
}

/** One non-blocking attempt at a seat's dispatch mutex; null while another live adapter run holds it. */
export async function tryAcquire(stateDir: string): Promise<(() => Promise<void>) | null> {
  const dir = path.join(stateDir, "dispatch.lock");
  const pending = path.join(stateDir, "dispatch.pending");
  const databasePath = path.join(stateDir, "dispatch-mutex.sqlite");
  const stat = await fs.lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new Error("Seat mutex database must be a plain, unshared file");

  // As with workspace restore locks, SQLite owns all descriptors for this
  // permanent inode. Never unlink it or open/close a raw descriptor: POSIX
  // locks could otherwise be lost or split across different inodes.
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  let locked = false;
  let claimed = false;
  try {
    database.exec("PRAGMA busy_timeout=0;");
    try {
      database.exec("BEGIN IMMEDIATE;");
      locked = true;
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (typeof code === "number" && (code & 0xff) === 5) return null; // SQLITE_BUSY
      throw error;
    }
    await fs.chmod(databasePath, 0o600);

    // Respect pre-upgrade owners. Only a definitely dead legacy PID permits
    // reclaim; missing/invalid metadata stays busy. All upgraded contenders
    // hold the SQLite lock before reading, reclaiming or removing this path.
    const existing = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const pidText = await fs.readFile(path.join(dir, "pid"), "utf8").catch(() => "");
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid <= 1) return null;
      try {
        process.kill(pid, 0);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
      }
      // Preserve stale metadata and active.json; no provider work is replayed.
      await fs.rename(dir, path.join(stateDir, `stale-lock-${Date.now()}-${randomUUID().slice(0, 8)}`));
    }

    // Publish a complete legacy-compatible diagnostic directory atomically.
    // Death before PID publication leaves only pending scratch; the next
    // SQLite owner can discard that scratch safely, even if it has no PID.
    await fs.rm(pending, { recursive: true, force: true });
    await fs.mkdir(pending, { mode: 0o700 });
    await fs.writeFile(path.join(pending, "pid"), String(process.pid), { mode: 0o600 });
    await fs.rename(pending, dir);
    claimed = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        // Keep process ownership until removal completes. Repeated unlocks
        // must never touch a successor's directory or close its connection.
        await fs.rm(dir, { recursive: true, force: true });
      } finally { database.close(); }
    };
  } finally {
    if (!claimed) {
      try {
        if (locked) await fs.rm(pending, { recursive: true, force: true });
      } finally { database.close(); }
    }
  }
}

export async function acquire(stateDir: string, deadline: number): Promise<() => Promise<void>> {
  while (Date.now() < deadline) {
    const unlock = await tryAcquire(stateDir);
    if (unlock) return unlock;
    await sleep(1000);
  }
  throw new Error("agy single Remote Control session busy: serialization timeout");
}

/** SCO-991: one tmux seat per concurrent run. Slot 0 is the agent's configured seat, unchanged. */
export type AgySlot = { index: number; session: string; stateDir: string; cwd: string };
export const AGY_MAX_SLOTS = 50;
const SLOT_WORKSPACE_ROOT = "/Volumes/NVM/AI_Agent_Runtime/workspaces";
/** Ownership rule: agy runs one Claude/GPT job at a time, so only Gemini tiers get more than one seat. */
export function agySlotCount(slots: unknown, model: string): number {
  if (!model.startsWith("gemini-")) return 1;
  const n = Math.trunc(Number(slots));
  return Number.isFinite(n) ? Math.min(AGY_MAX_SLOTS, Math.max(1, n)) : 1;
}
export function agySlotCountForAgent(agent: AdapterExecutionContext["agent"], model: string): number {
  return agySlotCount(parseHeartbeatPolicy(agent as Parameters<typeof parseHeartbeatPolicy>[0]).maxConcurrentRuns, model);
}
export function agySlot(index: number, socket: string, session: string, stateDir: string, cwd: string): AgySlot {
  if (index === 0) return { index, session, stateDir, cwd };
  // Own cwd per seat: the global statusLine routes snapshots by cwd, and seats must not share a status file.
  return { index, session: `${session}-s${index}`, stateDir: path.join(stateDir, `s${index}`),
    cwd: path.join(SLOT_WORKSPACE_ROOT, `${socket}-s${index}`) };
}

/**
 * Pick and lock one seat: the seat already holding this issue's checkpoint (adoption),
 * else the first free seat without an unresolved checkpoint. Finished foreign receipts are settled on the way.
 */
export async function claimSlot(
  ctx: AdapterExecutionContext, slots: AgySlot[], issueId: string, deadline: number,
): Promise<{ slot: AgySlot; unlock: () => Promise<void> }> {
  if (ctx.signal?.aborted) throw new Error("agy run cancelled; shared TUI left intact, active checkpoint preserved");
  for (const slot of slots) await fs.mkdir(slot.stateDir, { recursive: true, mode: 0o700 });
  const activeOf = (slot: AgySlot) => fs.readFile(path.join(slot.stateDir, "active.json"), "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const owner = await (async () => {
    for (const slot of slots) {
      const raw = await activeOf(slot);
      try { if (raw && (JSON.parse(raw) as Partial<ActiveDispatch>).issueId === issueId) return slot; } catch { /* unresolved */ }
    }
    return null;
  })();
  if (ctx.context.paperclipRestartReattach === true) {
    // A restart is not permission to submit a new turn, or to adopt another
    // run on the same issue. The old provider may still be working.
    if (!owner) throw new Error("agy restart checkpoint missing; provider ownership requires reconciliation");
    const unlock = await acquire(owner.stateDir, deadline);
    try {
      const active = adoptableActive(await activeOf(owner), issueId, owner.stateDir);
      if (!active || active.runId !== ctx.runId) throw new Error("agy restart checkpoint run mismatch; provider ownership requires reconciliation");
      return { slot: owner, unlock };
    } catch (error) {
      await unlock();
      throw error;
    }
  }
  // A duplicate wake must not wait inside an adapter until the seat times out.
  // Preserve issue affinity: an occupied owner seat cannot spill into another seat.
  for (const slot of owner ? [owner] : slots) {
    const unlock = await tryAcquire(slot.stateDir);
    if (!unlock) continue;
    try {
      let raw = await activeOf(slot);
      const state = await checkpointRunState(ctx, raw);
      if (state === "live" || state === "unknown") { await unlock(); continue; }
      if (raw && state === "terminal") {
        await settleForeignCheckpoint(ctx, raw, issueId, slot.stateDir, path.join(slot.stateDir, "active.json"));
        raw = await activeOf(slot);
      }
      adoptableActive(raw, issueId, slot.stateDir);
      return { slot, unlock };
    } catch (error) {
      await unlock();
      if (!isTargetBusyRefusal(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  throw new Error("agy previous task unresolved; Remote Control seat busy; wake coalesced without dispatch");
}

export type DeliveryDisposition = { status: "done" | "in_review"; reportRevisionId: string };

export async function deliver(ctx: AdapterExecutionContext, receipt: Receipt, title = "Antigravity execution report", label = "agy Remote Control", stateDir?: string): Promise<DeliveryDisposition> {
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
    return await response.json(); // HTTP success alone is not persisted delivery evidence.
  };
  // A rerun on an issue that already has a report must send the revision it replaces, or PUT returns 409.
  const existing = await invoke("GET", "/documents/report", undefined) as { body?: unknown; latestRevisionId?: unknown } | null;
  if (existing !== null && (typeof existing?.latestRevisionId !== "string" || !existing.latestRevisionId))
    throw new Error("agy report response missing revision");
  const baseRevisionId = typeof existing?.latestRevisionId === "string" ? existing.latestRevisionId : undefined;
  const report = existing?.body === receipt.report ? existing : await invoke("PUT", "/documents/report", {
    title, format: "markdown", body: receipt.report,
    changeSummary: `${label} run ${ctx.runId}`,
    ...(baseRevisionId ? { baseRevisionId } : {}),
  }) as { body?: unknown; latestRevisionId?: unknown } | null;
  if (report?.body !== receipt.report || typeof report.latestRevisionId !== "string" || !report.latestRevisionId)
    throw new Error("agy report acknowledgement did not verify the receipt");
  // A retained receipt may already have entered review. Repeating done could
  // advance that review stage, so continuation only observes its persisted state.
  let persisted = await invoke("GET", "", undefined) as { status?: unknown } | null;
  if (persisted?.status !== "in_review" && persisted?.status !== "done") {
    if (typeof persisted?.status !== "string") throw new Error("agy issue response missing status");
    if (stateDir) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(receipt.runId)) throw new Error("invalid delivery source run");
      // Record intent before the transition: a lost/malformed acknowledgement
      // must never let a retry advance a review stage as another done request.
      const intent = await fs.open(path.join(stateDir, `delivery-intent-${receipt.runId}.json`), "wx", 0o600)
        .catch(error => {
          if (error.code === "EEXIST") throw new Error("agy status transition already attempted; checkpoint retained for reconciliation");
          throw error;
        });
      try { await intent.writeFile(JSON.stringify({ issueId: receipt.issueId, runId: receipt.runId })); await intent.sync(); }
      finally { await intent.close(); }
      const dir = await fs.open(stateDir, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
    persisted = await invoke("PATCH", "", { status: "done" }) as { status?: unknown } | null;
  }
  if (persisted?.status !== "done" && persisted?.status !== "in_review")
    throw new Error(`agy delivery remains ${String(persisted?.status)}; checkpoint retained`);
  return { status: persisted.status, reportRevisionId: report.latestRevisionId };
}

/**
 * active.json naming a DIFFERENT issue: a finished receipt is settled onto its issue and the checkpoint archived;
 * an unresolved checkpoint remains an ownership conflict, independent of TUI state.
 * The caller holds the state mutex, so no live adapter run owns this checkpoint.
 */
async function settleForeignCheckpoint(
  ctx: AdapterExecutionContext, raw: string, issueId: string, stateDir: string, activePath: string,
): Promise<void> {
  let a: Partial<ActiveDispatch>;
  try { a = JSON.parse(raw) as Partial<ActiveDispatch>; } catch { return; }
  if (!a || typeof a.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(a.runId) || typeof a.issueId !== "string"
      || a.issueId === issueId || !validReceiptPath(stateDir, a.runId, a.receiptPath)) return;
  let receipt: Receipt | null = null;
  try { receipt = parseReceipt(await fs.readFile(a.receiptPath, "utf8"), a.runId, a.issueId); } catch { /* none yet */ }
  if (!receipt) return; // adoptableActive preserves the unresolved ownership conflict
  try {
    const disposition = await deliver(ctx, receipt, undefined, undefined, stateDir);
    if (disposition.status === "in_review") return; // Preserve the original reconciliation context.
    await ctx.onLog("stdout", `[agy] Settled finished receipt of run ${a.runId} onto issue ${a.issueId}\n`);
  } catch (e) {
    await ctx.onLog("stderr", `[agy] Could not settle receipt of run ${a.runId} onto issue ${a.issueId} (${e instanceof Error ? e.message : e}); receipt kept at ${a.receiptPath}\n`);
    return;
  }
  await fs.rename(activePath, path.join(stateDir, `active.stale-${a.runId}-${Date.now()}.json`));
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cfg = ctx.config;
  const baseSession = asString(cfg.tmuxSession, "agy");
  const socket = asString(cfg.tmuxSocket, "paperclip-agy-rc");
  const baseStateDir = path.resolve(asString(cfg.stateDir, path.join(os.homedir(), ".paperclip/agy-rc-state")));
  const baseCwd = path.resolve(asString(cfg.cwd, path.join(os.homedir(), ".paperclip/agy-rc-workspace")));
  assertWorkableCwd(baseCwd);
  const requestedModel = asString(cfg.model, DEFAULT_MODEL);
  const model = AGY_MODELS.includes(requestedModel as typeof AGY_MODELS[number]) ? requestedModel : DEFAULT_MODEL;
  const slots = Array.from({ length: agySlotCountForAgent(ctx.agent, model) },
    (_, i) => agySlot(i, socket, baseSession, baseStateDir, baseCwd));
  let { session, stateDir, cwd } = slots[0]!;
  const issueId = asString(ctx.context.issueId, asString(ctx.context.taskId, ""));
  const timeoutMs = Math.min(3600, Math.max(30, Number(cfg.timeoutSec) || 600)) * 1000;
  let unlock: (() => Promise<void>) | undefined;
  let releaseHost: (() => Promise<void>) | undefined;
  let hostMayRelease = true;
  let dispatched = false;
  const failure = (reason: string, timedOut = false): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut, model, provider: "google", biller: "google",
    billingType: "subscription", costStatus: "unpriced", errorMessage: reason,
    ...(!dispatched && ctx.context.paperclipRestartReattach !== true && isTargetBusyRefusal(reason) ? { errorFamily: "target_busy" as const } : {}),
    ...(!dispatched && ctx.context.paperclipRestartReattach !== true
      ? { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } } : {}),
  });
  try {
    resolveAgyModel(requestedModel);
    if (!ID.test(socket) || !slots.every(slot => ID.test(slot.session))) throw new Error("invalid tmux socket/session");
    if (!issueId) throw new Error("agy adapter requires one issueId/taskId");
    if (!ctx.authToken) throw new Error("agy adapter requires a Paperclip run-scoped token before dispatch");
    if (ctx.executionTarget?.kind && ctx.executionTarget.kind !== "local")
      throw new Error("agy TUI adapter runs on Mac Pro local host only");
    const claimed = await claimSlot(ctx, slots, issueId, Date.now() + timeoutMs);
    unlock = claimed.unlock;
    ({ session, stateDir, cwd } = claimed.slot);
    if (slots.length > 1) await ctx.onLog("stdout", `[agy] seat ${claimed.slot.index + 1}/${slots.length}: tmux ${socket}/${session}\n`);
    const activePath = path.join(stateDir, "active.json");
    const activeRaw = await fs.readFile(activePath, "utf8").catch(() => "");
    const adopted = adoptableActive(activeRaw, issueId, stateDir);
    if (ctx.context.paperclipRestartReattach === true && (!adopted || adopted.runId !== ctx.runId))
      throw new Error("agy restart checkpoint changed; provider ownership requires reconciliation");
    if (isAgyHostLimitedModel(model)) {
      releaseHost = await claimAgyHostAdmission(AGY_HOST_ADMISSION,
        { runId: adopted?.runId ?? ctx.runId, issueId, stateDir }, Boolean(adopted));
      if (adopted) hostMayRelease = false;
    }
    const rcUrl = await ensureSession(socket, session, cwd, stateDir, Boolean(adopted), model);
    if (!rcUrl) throw new Error("agy RC URL unavailable: use /remote-control in its TUI, then retry");
    // Owner 2026-11-03: auto re-pin, logged. The URL rotates on every agy restart; ensureSession only reads it from the
    // adapter-owned private tmux socket/session, so a new URL there is the same owned instance. The pin lives in
    // stateDir (cfg.expectedRemoteControlUrl is only the initial seed). An in-flight adopted dispatch stays strict below.
    const pinPath = path.join(stateDir, "rc-url.json");
    const pinned = await fs.readFile(pinPath, "utf8").then((t) => asString(JSON.parse(t)?.url, "")).catch(() => "")
      || (claimed.slot.index === 0 ? asString(cfg.expectedRemoteControlUrl, rcUrl) : rcUrl);
    if (pinned !== rcUrl) {
      await ctx.onLog("stdout", `[agy] RC URL re-pinned ${pinned} -> ${rcUrl} (owned tmux ${socket}/${session})\n`);
    }
    if (pinned !== rcUrl || !(await fs.stat(pinPath).catch(() => null)))
      await fs.writeFile(pinPath, JSON.stringify({ url: rcUrl, previous: pinned === rcUrl ? null : pinned, at: new Date().toISOString(), runId: ctx.runId }), { mode: 0o600 });
    let receiptRunId = ctx.runId;
    let receiptPath = receiptFilePath(stateDir, ctx.runId);
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
    // Reuse the live conversation: /new could interrupt work or drop a queued wake.
    // Exact run/issue IDs in the receipt bind completion without clearing the TUI.
    conversationId = parseRemoteConversationId(await pane(socket, session));
    const buildDispatchPrompt = async () => {
    const promptBase = asString(cfg.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context);
    const instructionsFilePath = asString(cfg.instructionsFilePath, "");
    const instructionsPrefix = instructionsFilePath
      ? await fs.readFile(instructionsFilePath, "utf8")
      : "";
    const intro = renderTemplate(promptBase, {
      agent: ctx.agent, run: { id: ctx.runId }, context: ctx.context, companyId: ctx.agent.companyId,
    });
    const promptReceiptPath = path.join(await readableRuntimePath(ctx, "rc", stateDir), path.basename(receiptPath));
    const instructions = [
      `Paperclip run ${ctx.runId}, issue ${issueId}. Work on ONLY the assigned issue.`,
      "Your actions are visible and steerable through the single Antigravity Remote Control session.",
      `Use ${modelLabel(model)}. Do not switch models.`,
      " Never use secrets or guess Paperclip API credentials.",
      "Finish the requested issue work, then write a JSON receipt via your write_to_file tool",
      `to ${promptReceiptPath} with exactly these keys: runId = ${ctx.runId}, issueId = ${issueId},`,
      'status = "done", summary = a short factual summary, report = a detailed Markdown result (at least 250 characters).',
      "Write this only once actual work is complete. The Paperclip adapter will publish the report and close the issue",
      "under the run's scoped identity. Do NOT update the issue yourself. Do not write a done receipt on failure.",
      "If blocked, explain the blocker visibly without a done receipt. The adapter will leave the issue open.",
    ].join(" ");
    const prompt = normalizeOneLine(joinPromptSections([instructionsPrefix, intro, taskContextNote, wakePrompt,
      asString(ctx.context.paperclipSessionHandoffMarkdown, ""), instructions]));
    await assertAssembledPrompt({ seat: ctx.agent.name, model, prompt,
      share: cfg.tokenPreflightShare === undefined ? undefined : Number(cfg.tokenPreflightShare) });
    if (prompt.length > 50_000) throw new Error("agy prompt exceeds TUI paste budget");
    return prompt;
    };
    let prompt = await buildDispatchPrompt();
    const gate = await preflightSessionPrompt(ctx, model, prompt, conversationId);
    if (gate.rotate) {
      const snapshot = await readStatusSnapshot(stateDir) as AgyStatusLineSnapshot | null;
      // Ordinary wake delivery may queue on a working turn. A destructive /new
      // requires fresh positive evidence that the exact conversation is idle.
      if (!snapshot || snapshot.agentState !== "idle" || snapshot.conversationId !== conversationId
          || !Number.isFinite(Date.parse(snapshot.observedAt)) || Date.now() - Date.parse(snapshot.observedAt) > 10_000
          || Date.parse(snapshot.observedAt) > Date.now() || snapshot.pendingInputCount !== 0 || snapshot.toolConfirmationPending
          || !(await inputReadiness(socket, session)).allowed)
        throw new Error(`agy input guard refused context rotation: idle conversation not verified; ${gate.reason}`);
      applyPromptRotation(ctx, gate);
      prompt = await buildDispatchPrompt();
      await send(socket, session, "/new", stateDir);
      const before = conversationId;
      const deadline = Date.now() + 12_000;
      do {
        conversationId = parseRemoteConversationId(await pane(socket, session));
        if (conversationId && conversationId !== before) break;
        await sleep(500);
      } while (Date.now() < deadline);
      if (!conversationId || conversationId === before)
        throw new Error("agy /new did not confirm an isolated conversation; no prompt sent");
      await ctx.onLog("stderr", `[paperclip] Starting fresh: ${gate.reason}\n`);
    }
    // No checkpoint is created for an initial guard refusal. Once a checkpoint
    // exists, a crash or uncertain paste still requires reconciliation.
    const preflight = await inputReadiness(socket, session);
    if (!preflight.allowed) throw new Error(`agy input guard refused before dispatch: ${preflight.reason}`);
    hostMayRelease = false;
    await fs.writeFile(activePath, JSON.stringify({
      runId: ctx.runId, issueId, receiptPath, rcUrl, tmuxSocket: socket, tmuxSession: session,
      conversationId, startedAt: new Date().toISOString(),
    }, null, 2), { flag: "wx", mode: 0o600 });
    ctx.onDispatch?.();
    dispatched = true;
    await ctx.onLog("stdout", `[agy] Dispatching issue ${issueId} in shared RC ${rcUrl}; receipt ${receiptPath}\n`);
    await send(socket, session, prompt, stateDir);
    }
    const deadline = Date.now() + timeoutMs;
    let receipt: Receipt | null = null;
    let compactAfter = 0;
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new Error("agy run cancelled; shared TUI left intact, active checkpoint preserved");
      const raw = await fs.readFile(receiptPath, "utf8").catch(() => "");
      if (raw) {
        receipt = parseReceipt(raw, receiptRunId, issueId);
        break;
      }
      // 200k context cap: compact with an empty editor, regardless of turn activity.
      if (!receipt && Date.now() >= compactAfter && needsCompaction(await readStatusSnapshot(stateDir))
          && (await inputReadiness(socket, session)).allowed) {
        await ctx.onLog("stdout", `[agy] context over ${AGY_CONTEXT_LIMIT_TOKENS} tokens; sending /compact\n`);
        await send(socket, session, AGY_COMPACT_PROMPT, stateDir);
        compactAfter = Date.now() + 120_000;
      }
      // A terminated pane must never be mistaken for successful agent work.
      await tmux(socket, ["has-session", ...target(session)]);
      await sleep(1100);
    }
    if (!receipt)
      return failure("agy did not produce a validated completion receipt; checkpoint retained", true);
    if (releaseHost) {
      const receiptMtime = (await fs.stat(receiptPath)).mtimeMs;
      const idleDeadline = Date.now() + 20_000;
      do {
        if (isAgyAdmissionIdle(await readStatusSnapshot(stateDir), conversationId, receiptMtime)) {
          hostMayRelease = true;
          break;
        }
        if (ctx.signal?.aborted) break;
        await sleep(500);
      } while (Date.now() < idleDeadline);
      if (!hostMayRelease)
        return failure("agy Claude/GPT host admission retained: provider idle was not confirmed after the receipt");
    }
    const disposition = await deliver(ctx, receipt, undefined, undefined, stateDir);
    const issueClosed = disposition.status === "done";
    await ctx.onLog("stdout", `[agy] ${issueClosed ? "Done" : "Awaiting review"} ${issueId}: ${receipt.summary}; conversation=${conversationId ?? "unknown"}\n`);
    if (issueClosed) await fs.rm(activePath);
    return {
      exitCode: 0, signal: null, timedOut: false, provider: "google", biller: "google", model,
      billingType: "subscription", costStatus: "unpriced", summary: receipt.summary,
      sessionId: conversationId, sessionDisplayId: conversationId,
      sessionParams: { sessionId: conversationId, cwd, remoteControlUrl: rcUrl, tmuxSocket: socket, tmuxSession: session },
      resultJson: { issueId, receiptPath, remoteControlUrl: rcUrl, conversationId, reportPublished: true,
        issueClosed, issueStatus: disposition.status, reviewPending: !issueClosed },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await ctx.onLog("stderr", `[agy] ${error}\n`);
    return failure(error);
  } finally {
    try { if (releaseHost && hostMayRelease) await releaseHost(); }
    finally { if (unlock) await unlock(); }
  }
}
