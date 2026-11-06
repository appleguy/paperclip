// NAR OpenCode driver over the v2.2.5 session HTTP API (anomalyco/opencode packages/protocol/src/groups/session.ts).
// Spec: doc/spec/native-agent-runtime.md section 3.2. Transport only: never writes Paperclip state, never retries a send.
// Ids are client-chosen and derived from Paperclip identities, so the server's durable admission is idempotent:
//   session  ses_<sha256(agent|issue)>   (POST /api/session {id})
//   message  msg_<sha256(opId)>          (POST /api/session/:id/prompt {id})
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  Capabilities, ConvScope, Fence, HostHandle, ObserveEvent, Op, OutcomeRead, ProviderDriver, SubmitResult,
} from "./types.js";

// Provider boundary: this driver lives with the OpenCode adapter (the adapter package is source-exported and
// depends only on adapter-utils). paperclip-runner/src/nar keeps the interface + conformance suite and imports
// this file by relative path in its test. The matrix cell mirrors paperclip-runner/src/nar/capabilities.ts.
export const OPENCODE_CAPABILITIES: Capabilities = {
  provider: "opencode",
  inputKind: "http_api",
  ackGrade: "accepted_provider",
  receiptKinds: ["mcp_tool", "provider_event"],
  ownerPhone: { path: "Herdr/Moshi pane (generic)", proof: "OPEN" },
  permission: { route: "provider_policy", proof: "OPEN" },
  resume: { byId: true, proof: "SHIPPED-UNPROVEN" },
  // The HTTP interrupt targets the whole session; checking the active message
  // first does not atomically fence a successor.
  interrupt: { scoped: false, proof: "OPEN" },
  needsPane: false,
  observeCoverage: "complete",
};

export const QUALIFIED_OPENCODE_V2 = "2.2.5";
type Fetch = typeof fetch;
export interface OpenCodeHttpOptions {
  url: string; // loopback only, e.g. http://127.0.0.1:19403
  passwordFile: string; // read per request, never stored on the handle
  username?: string; // OpenCode server basic-auth user, default "opencode"
  hostEpoch?: number;
  expectedPid?: number; // e.g. from the launchd job, checked against /api/info
  fetchImpl?: Fetch;
  timeoutMs?: number;
  now?: () => string;
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** Generation 0 keeps the original id; each Paperclip session rotation moves the pair to the next generation. */
export const sessionIdFor = (s: Pick<ConvScope, "agentId" | "issueId">, generation = 0) =>
  `ses_${hex(`nar|${s.agentId}|${s.issueId}${generation > 0 ? `|g${generation}` : ""}`).slice(0, 26)}`;
export const MAX_SESSION_GENERATION = 500;
export const defaultSessionTitle = (issueId: string) => `Paperclip ${issueId}`;
/** `SCO-12 Issue title`, whitespace collapsed and capped for the session list; null without an identifier. */
export function sessionTitleFor(identifier: unknown, title: unknown): string | undefined {
  const id = typeof identifier === "string" ? identifier.trim() : "";
  if (!id) return undefined;
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  const full = t ? `${id} ${t}` : id;
  return full.length > 120 ? `${full.slice(0, 119)}\u2026` : full;
}
export const messageIdFor = (opId: string) => `msg_${hex(`nar|${opId}`).slice(0, 26)}`;

// Rejoin pages the session's newest-first message list looking for the latest user prompt; bounded so a
// pathological session cannot turn one rejoin check into an unbounded scan (50 x 200 = 10k messages).
const INFLIGHT_MESSAGE_PAGE_SIZE = 200;
const INFLIGHT_MESSAGE_MAX_PAGES = 50;

export class OpenCodeHttpError extends Error {
  constructor(readonly code: "auth" | "http" | "mismatch" | "transport" | "unqualified", message: string, readonly status?: number) {
    super(message);
  }
}

export class OpenCodeHttpDriver implements ProviderDriver {
  private readonly f: Fetch;
  private readonly url: string;
  constructor(private readonly o: OpenCodeHttpOptions) {
    const u = new URL(o.url);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      throw new OpenCodeHttpError("unqualified", `OpenCode driver is loopback-only: ${o.url}`);
    }
    this.url = u.origin;
    this.f = o.fetchImpl ?? fetch;
  }

  capabilities(): Capabilities {
    return OPENCODE_CAPABILITIES;
  }

  private auth(): string {
    const pw = readFileSync(this.o.passwordFile, "utf8").trim();
    return "Basic " + Buffer.from(`${this.o.username ?? "opencode"}:${pw}`).toString("base64");
  }

  private async req(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 15000);
    try {
      return await this.f(this.url + path, {
        method,
        redirect: "error",
        signal: ctl.signal,
        headers: { authorization: this.auth(), accept, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async json(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    let r: Response;
    try {
      r = await this.req(method, path, body);
    } catch (e) {
      throw new OpenCodeHttpError("transport", `${method} ${path}: ${(e as Error).message}`);
    }
    if (r.status === 401 || r.status === 403) throw new OpenCodeHttpError("auth", `${method} ${path}: HTTP ${r.status}`, r.status);
    const text = await r.text();
    let data: any = undefined;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
    return { status: r.status, data };
  }

  // Existing host only (the launchd lane owns the server). Attestation is the authenticated /api/info identity:
  // qualified version, a real OS pid and our own loopback URL. /global/health is unauthenticated (serves the web
  // app) and proves nothing. The server pid is the default host epoch, so a server restart is an epoch change.
  async attestHost(_agentId: string, opts?: { create?: boolean }): Promise<HostHandle> {
    if (opts?.create) throw new OpenCodeHttpError("unqualified", "OpenCode lanes are launchd-owned; driver never creates a server");
    const info = await this.json("GET", "/api/info");
    const d = info.data;
    if (info.status !== 200 || d?.version !== QUALIFIED_OPENCODE_V2) {
      throw new OpenCodeHttpError("unqualified", `OpenCode info ${info.status} version ${String(d?.version)}; need ${QUALIFIED_OPENCODE_V2}`);
    }
    if (!Number.isInteger(d.pid) || d.pid <= 0) throw new OpenCodeHttpError("unqualified", "OpenCode server has no OS process identity");
    if (this.o.expectedPid !== undefined && d.pid !== this.o.expectedPid) {
      throw new OpenCodeHttpError("mismatch", `OpenCode pid ${d.pid} != expected ${this.o.expectedPid}`);
    }
    if (!Array.isArray(d.urls) || !d.urls.some((u: string) => { try { return new URL(u).origin === this.url; } catch { return false; } })) {
      throw new OpenCodeHttpError("mismatch", `OpenCode server does not advertise ${this.url}`);
    }
    return { provider: "opencode", hostEpoch: this.o.hostEpoch ?? d.pid, attested: true, detail: { url: this.url, version: d.version, pid: d.pid } };
  }

  /** Server OS pid from /api/info, or null when the server is unreachable. A pid change is a server restart. */
  async probePid(): Promise<number | null> {
    try {
      const info = await this.json("GET", "/api/info");
      return info.status === 200 && Number.isInteger(info.data?.pid) && info.data.pid > 0 ? info.data.pid : null;
    } catch {
      return null;
    }
  }

  /** Highest generation of this agent+issue pair that exists on the server, or -1 when none does. */
  async latestGeneration(s: Pick<ConvScope, "agentId" | "issueId">): Promise<number> {
    let latest = -1;
    for (let g = 0; g <= MAX_SESSION_GENERATION; g++) {
      const r = await this.json("GET", `/api/session/${encodeURIComponent(sessionIdFor(s, g))}`);
      if (r.status === 404) break;
      if (r.status !== 200) throw new OpenCodeHttpError("http", `session.get generation ${g} HTTP ${r.status}`, r.status);
      latest = g;
    }
    return latest;
  }

  async bindConversation(_h: HostHandle, s: ConvScope, mode: "new" | "resume", _f: Fence, existingId?: string) {
    const id = existingId ?? sessionIdFor(s);
    if (mode === "new") {
      const body: Record<string, unknown> = { id, title: s.title ?? defaultSessionTitle(s.issueId), location: { directory: s.cwd }, metadata: { paperclip: { agentId: s.agentId, issueId: s.issueId } } };
      if (s.model) body.model = parseModelRef(s.model);
      const r = await this.json("POST", "/api/session", body);
      // A duplicate id (earlier create whose reply was lost) falls through to read-back verification.
      if (r.status !== 200 && r.status !== 409) throw new OpenCodeHttpError("http", `session.create HTTP ${r.status}`, r.status);
    }
    const g = await this.json("GET", `/api/session/${encodeURIComponent(id)}`);
    if (g.status !== 200) throw new OpenCodeHttpError("http", `session.get ${id} HTTP ${g.status}`, g.status);
    const info = g.data?.data;
    if (info?.id !== id) throw new OpenCodeHttpError("mismatch", `session id ${String(info?.id)} != ${id}`);
    const cwd = info?.location?.directory;
    if (cwd !== s.cwd) throw new OpenCodeHttpError("mismatch", `session cwd ${String(cwd)} != ${s.cwd}`);
    await this.retitle(id, info?.title, s);
    const model = info?.model ? `${info.model.providerID}/${info.model.id}${info.model.variant ? `#${info.model.variant}` : ""}` : undefined;
    if (s.model && model && model !== s.model) throw new OpenCodeHttpError("mismatch", `session model ${model} != ${s.model}`);
    return { conversationId: id, cwd, model };
  }

  // Resume path: sessions created before the title carried the issue (or by a run without wake context) keep the
  // placeholder `Paperclip <issueId>`. Replace only our own placeholder or an earlier `<identifier> <title>`;
  // a title the owner set by hand is left alone. Advisory: a failed PATCH never fails the attempt.
  private async retitle(id: string, current: unknown, s: ConvScope): Promise<void> {
    if (!s.title || typeof current !== "string" || current === s.title) return;
    const identifier = s.title.split(/\s+/, 1)[0];
    if (!current.startsWith("Paperclip ") && !current.startsWith(`${identifier} `)) return;
    try {
      await this.json("PATCH", `/api/session/${encodeURIComponent(id)}`, { title: s.title });
    } catch { /* advisory */ }
  }

  // One POST, never retried. A reply echoing our msg id is durable admission (accepted_provider);
  // anything ambiguous after the bytes may have left is outcome_unknown and Core holds it (R-N1).
  async submit(_h: HostHandle, conversationId: string, op: Op, _f: Fence): Promise<SubmitResult> {
    const at = (this.o.now ?? (() => new Date().toISOString()))();
    const msgId = messageIdFor(op.opId);
    this.rememberOp(op.opId);
    if (op.kind !== "prompt" || typeof op.text !== "string") throw new OpenCodeHttpError("unqualified", "submit takes prompt ops with text");
    let r: { status: number; data: any };
    try {
      r = await this.json("POST", `/api/session/${encodeURIComponent(conversationId)}/prompt`, { id: msgId, text: op.text });
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.code === "auth") throw e; // rejected before admission
      return { grade: "outcome_unknown", evidence: `prompt ${msgId}: ${(e as Error).message}`, at };
    }
    const d = r.data?.data;
    if (r.status === 200 && d?.id === msgId) return { grade: "accepted_provider", evidence: `inbox ${msgId} admitted in ${conversationId}`, at };
    if (r.status === 409 && (await this.messageExists(conversationId, msgId))) {
      return { grade: "accepted_provider", evidence: `inbox ${msgId} already admitted in ${conversationId}`, at };
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 409) throw new OpenCodeHttpError("http", `prompt rejected HTTP ${r.status}`, r.status);
    return { grade: "outcome_unknown", evidence: `prompt ${msgId}: HTTP ${r.status}`, at };
  }

  async messageExists(conversationId: string, msgId: string): Promise<boolean> {
    const inbox = await this.json("GET", `/api/session/${encodeURIComponent(conversationId)}/inbox`);
    if (inbox.status !== 200 || !Array.isArray(inbox.data?.data) ||
        inbox.data.data.some((i: any) => !i || typeof i.id !== "string")) {
      throw new OpenCodeHttpError("mismatch", "cannot inspect inbox for the original message");
    }
    if (inbox.data.data.some((i: any) => i.id === msgId)) return true;
    const m = await this.json("GET", `/api/session/${encodeURIComponent(conversationId)}/message/${encodeURIComponent(msgId)}`);
    if (m.status === 404) return false;
    if (m.status !== 200 || m.data?.data?.id !== msgId || m.data?.data?.type !== "user") {
      throw new OpenCodeHttpError("mismatch", "cannot verify the original message");
    }
    return true;
  }

  // Durable session log replay (after is an exclusive aggregate seq); no follow, ends at the captured watermark.
  async observe(conversationId: string, cursor?: string) {
    const after = cursor && /^\d+$/.test(cursor) ? `&after=${cursor}` : "";
    let r: Response;
    try {
      r = await this.req("GET", `/api/experimental/session/${encodeURIComponent(conversationId)}/log?follow=false${after}`, undefined, "text/event-stream");
    } catch (e) {
      throw new OpenCodeHttpError("transport", `session.log: ${(e as Error).message}`);
    }
    if (r.status === 401 || r.status === 403) throw new OpenCodeHttpError("auth", `session.log HTTP ${r.status}`, r.status);
    if (r.status !== 200) throw new OpenCodeHttpError("http", `session.log HTTP ${r.status}`, r.status);
    const events: ObserveEvent[] = [];
    let next = cursor ?? "";
    let synced = false;
    let last = cursor && /^\d+$/.test(cursor) ? Number(cursor) : -1;
    let watermark = -1;
    for (const item of parseSse(await r.text())) {
      if (item?.type === "log.synced") {
        // Watermark: the log filters non-public events, so seqs may jump; advance the cursor to it.
        if (item.aggregateID !== conversationId) throw new OpenCodeHttpError("mismatch", `foreign log.synced in ${conversationId}`);
        if (typeof item.seq === "number" && item.seq > watermark) watermark = item.seq;
        synced = true;
        continue;
      }
      const seq = item?.durable?.seq;
      if (typeof seq !== "number" || item?.durable?.aggregateID !== conversationId || typeof item?.id !== "string" || !item.id.startsWith("evt_")) {
        throw new OpenCodeHttpError("mismatch", `foreign or malformed log item in ${conversationId}`);
      }
      if (seq <= last) throw new OpenCodeHttpError("mismatch", `log sequence regressed ${seq} <= ${last}`);
      last = seq;
      next = String(seq);
      const inbox = item?.data?.inboxID;
      events.push({ cursor: next, kind: item.type, opId: inbox ? this.ops.get(inbox) : undefined, raw: item });
    }
    if (watermark > last) next = String(watermark);
    return { events, next, coverage: synced ? ("complete" as const) : ("incomplete" as const) };
  }
  private readonly ops = new Map<string, string>();
  rememberOp(opId: string) { this.ops.set(messageIdFor(opId), opId); }

  // Provider-side evidence only; "receipted" is Core's call (R-N3), so this never returns it.
  async readOutcome(conversationId: string, opId: string): Promise<OutcomeRead> {
    this.rememberOp(opId);
    return this.readOutcomeMsg(conversationId, messageIdFor(opId));
  }

  // Rejoin (spec: restart resumes, never replays): the user message the conversation is still working on, or
  // null when it is idle. A retry run after a Paperclip restart settles on this message instead of submitting
  // a second prompt into the same conversation.
  async inflightMessage(conversationId: string, options?: { cancelPendingMessageId: string }): Promise<string | null> {
    const sid = encodeURIComponent(conversationId);
    const inbox = await this.json("GET", `/api/session/${sid}/inbox`);
    if (inbox.status !== 200 || !Array.isArray(inbox.data?.data)) {
      throw new OpenCodeHttpError("http", `session.inbox HTTP ${inbox.status} or malformed response`, inbox.status);
    }
    const pending = inbox.data.data;
    if (pending.some((item: unknown) => !item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string")) {
      throw new OpenCodeHttpError("mismatch", "session.inbox contains an item without an id");
    }
    if (options && pending.some((item: any) => item.id === options.cancelPendingMessageId)) {
      const cancelled = await this.json("DELETE", `/api/session/${sid}/inbox/${encodeURIComponent(options.cancelPendingMessageId)}`);
      if (cancelled.status !== 204) throw new OpenCodeHttpError("http", `session.inbox cancellation HTTP ${cancelled.status}`, cancelled.status);
      return this.inflightMessage(conversationId);
    }
    const last = pending[pending.length - 1];
    if (typeof last?.id === "string") return last.id;
    const active = await this.json("GET", "/api/session/active");
    if (active.status !== 200 || typeof active.data?.data !== "object") throw new OpenCodeHttpError("http", `session.active HTTP ${active.status}`, active.status);
    if (!active.data.data?.[conversationId]) return null;
    // The list is newest first. A turn that has run for hours is hundreds of assistant/tool messages after its one
    // user prompt, so the newest page holds no user message: walk older pages (`cursor.next`) until one does.
    let cursor: string | null = null;
    for (let page = 0; page < INFLIGHT_MESSAGE_MAX_PAGES; page++) {
      const list = await this.json("GET", `/api/session/${sid}/message?limit=${INFLIGHT_MESSAGE_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (list.status !== 200 && page > 0) throw new OpenCodeHttpError("http", `session.message page ${page} HTTP ${list.status}`, list.status);
      const msgs: any[] = list.status === 200 && Array.isArray(list.data?.data) ? list.data.data : [];
      const user = msgs.filter((m) => m?.type === "user" && typeof m?.id === "string")
        .sort((a, b) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0))[0];
      if (user) return user.id;
      const next = list.data?.cursor?.next;
      if (typeof next !== "string" || !next || next === cursor) break;
      cursor = next;
    }
    throw new OpenCodeHttpError("mismatch", `active session ${conversationId} has no user message`);
  }

  // Progress fingerprint: the newest message of the conversation (list is newest first) changes whenever a
  // part streams, a tool settles or tokens update. null when unreadable, so a read failure never counts as a stall.
  async progressMark(conversationId: string): Promise<string | null> {
    try {
      const list = await this.json("GET", `/api/session/${encodeURIComponent(conversationId)}/message?limit=1`);
      if (list.status !== 200 || !Array.isArray(list.data?.data)) return null;
      return createHash("sha256").update(JSON.stringify(list.data.data[0] ?? null)).digest("hex");
    } catch {
      return null;
    }
  }

  async progressMessages(conversationId: string, messageId: string): Promise<Array<{ id: string; content: any[] }>> {
    const sid = encodeURIComponent(conversationId);
    const target = await this.json("GET", `/api/session/${sid}/message/${encodeURIComponent(messageId)}`);
    const created = target.data?.data?.time?.created;
    if (target.status !== 200 || target.data?.data?.id !== messageId || typeof created !== "number") return [];
    const messages: any[] = [];
    let cursor: string | null = null;
    let foundTarget = false;
    for (let page = 0; page < INFLIGHT_MESSAGE_MAX_PAGES; page++) {
      const list = await this.json("GET", `/api/session/${sid}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (list.status !== 200 || !Array.isArray(list.data?.data)) return [];
      messages.push(...list.data.data);
      if (messages.some((m: any) => m?.id === messageId && m.type === "user")) { foundTarget = true; break; }
      const nextCursor = list.data?.cursor?.next;
      if (typeof nextCursor !== "string" || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (!foundTarget) return [];
    const next = messages.filter((m: any) => m?.type === "user" && m.id !== messageId && m.time?.created > created)
      .reduce((min: number, m: any) => Math.min(min, m.time.created), Infinity);
    return messages.filter((m: any) => m?.type === "assistant" && typeof m.id === "string" &&
      typeof m.time?.created === "number" && m.time.created >= created && m.time.created < next && Array.isArray(m.content))
      .sort((a: any, b: any) => a.time.created - b.time.created)
      .map((m: any) => ({ id: m.id, content: m.content }));
  }

  /** Prove that no newer user message can contaminate a recovered turn's result. */
  async hasSuccessor(conversationId: string, messageId: string): Promise<boolean> {
    const sid = encodeURIComponent(conversationId);
    let cursor: string | null = null;
    for (let page = 0; page < INFLIGHT_MESSAGE_MAX_PAGES; page++) {
      const list = await this.json("GET", `/api/session/${sid}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (list.status !== 200 || !Array.isArray(list.data?.data)) throw new OpenCodeHttpError("mismatch", "cannot inspect successor messages");
      for (const message of list.data.data) {
        if (!message || typeof message !== "object" || typeof message.id !== "string" || typeof message.type !== "string") {
          throw new OpenCodeHttpError("mismatch", "malformed message during successor inspection");
        }
        if (message.id === messageId) {
          if (message.type !== "user") throw new OpenCodeHttpError("mismatch", "recovered message is not a user prompt");
          return false;
        }
        if (message.type === "user") return true;
      }
      const next = list.data?.cursor?.next;
      if (typeof next !== "string" || !next || next === cursor) break;
      cursor = next;
    }
    throw new OpenCodeHttpError("mismatch", "recovered message not found in message history");
  }

  async readOutcomeMsg(conversationId: string, msgId: string): Promise<OutcomeRead> {
    let log;
    try { log = await this.observe(conversationId); } catch { return "unknown"; }
    let admittedAt = -1;
    for (const e of log.events) {
      const raw = e.raw as any;
      if ((e.kind === "session.inbox.delivered" || e.kind === "session.inbox.enqueued") && raw?.data?.inboxID === msgId) {
        if (admittedAt < 0) admittedAt = Number(e.cursor);
      } else if (admittedAt >= 0 && TERMINAL.has(e.kind) && Number(e.cursor) > admittedAt) {
        return "hook_observed";
      }
    }
    // 2.2.5 serves only the log.synced watermark (execution/inbox events are not public), so settle from
    // projected state: our message admitted, not pending in the inbox, session not active, and idle after it.
    try {
      return await this.stateOutcome(conversationId, msgId);
    } catch {
      return admittedAt >= 0 ? "working" : "unknown";
    }
  }

  private async stateOutcome(conversationId: string, msgId: string): Promise<OutcomeRead> {
    const sid = encodeURIComponent(conversationId);
    const m = await this.json("GET", `/api/session/${sid}/message/${encodeURIComponent(msgId)}`);
    if (m.status === 404) return (await this.messageExists(conversationId, msgId)) ? "working" : "unknown";
    const created = m.data?.data?.time?.created;
    if (m.status !== 200 || m.data?.data?.id !== msgId || typeof created !== "number") return "unknown";
    const inbox = await this.json("GET", `/api/session/${sid}/inbox`);
    if (inbox.status !== 200 || !Array.isArray(inbox.data?.data)) return "working";
    if (inbox.data.data.some((i: any) => i?.id === msgId)) return "working";
    const active = await this.json("GET", "/api/session/active"); // read before info: idle seen after inactive is real
    if (active.status !== 200 || typeof active.data?.data !== "object") return "working";
    if (active.data.data?.[conversationId]) return "working";
    const s = await this.json("GET", `/api/session/${sid}`);
    const t = s.data?.data?.time;
    if (s.status === 200 && typeof t?.idle === "number" && t.idle >= created && s.data.data.outcome) return "hook_observed";
    return "working";
  }

  async verifyStoppedMessage(conversationId: string, messageId: string): Promise<boolean> {
    try {
      if (await this.stateOutcome(conversationId, messageId) !== "hook_observed") return false;
      return await this.inflightMessage(conversationId) === null;
    } catch {
      return false;
    }
  }

  // The inbox DELETE names the exact queued message. Session interrupt has no
  // atomic expected-message condition: even a matching read can race a direct
  // client or a successor. Hold active work until the provider offers that
  // condition, rather than interrupting a potentially different turn.
  async interruptExpectedMessage(conversationId: string, messageId: string, _op: Op, _fence: Fence): Promise<"requested" | "uncertain" | "idle"> {
    try {
      if (await this.inflightMessage(conversationId, { cancelPendingMessageId: messageId }) !== messageId) return "idle";
    } catch {
      // An unreadable state is not authority to cancel an unverified turn.
      return "uncertain";
    }
    return "uncertain";
  }

  async interrupt(_conversationId: string, _op: Op, _f: Fence): Promise<"requested" | "uncertain"> {
    return "uncertain";
  }
}

const TERMINAL = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

export function parseModelRef(input: string): { providerID: string; id: string; variant?: string } {
  const p = input.indexOf("/");
  if (p <= 0) throw new OpenCodeHttpError("unqualified", `invalid model reference ${input}`);
  const v = input.indexOf("#", p + 1);
  const id = input.slice(p + 1, v === -1 ? undefined : v);
  const variant = v === -1 ? undefined : input.slice(v + 1);
  if (!id || (variant !== undefined && !variant)) throw new OpenCodeHttpError("unqualified", `invalid model reference ${input}`);
  return variant ? { providerID: input.slice(0, p), id, variant } : { providerID: input.slice(0, p), id };
}

export function parseSse(text: string): any[] {
  const out: any[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { throw new OpenCodeHttpError("mismatch", "malformed SSE data frame"); }
  }
  return out;
}
