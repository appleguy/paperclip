import { realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";
import WebSocket from "ws";
import { CodexRpcError, type CodexAppServerTransport, type CodexRpcNotification, type CodexServerRequestHandler } from "./app-server-transport.js";

/** Immutable expected identity, verified independently by the server-owned admission callback. */
export interface SharedDaemonIdentity {
  codexHome: string;
  socketPath: string;
  cliVersion: string;
  appServerVersion: string;
  processGeneration: string;
  threadId: string;
  workspace: string;
  model: string;
  effort: string;
}
export interface SharedDaemonTransportOptions {
  identity: SharedDaemonIdentity;
  /** Must check the live daemon and Paperclip checkout/lease; IDs supplied here do not grant authority. */
  admit: (identity: Readonly<SharedDaemonIdentity>, operation: {method: string; params: Readonly<Record<string, unknown>>}) => Promise<boolean>;
  /** Optional server policy: only this callback may identify an owner intervention. */
  classifyIntervention?: (identity: Readonly<SharedDaemonIdentity>, event: CodexRpcNotification) => Promise<"owner" | "unknown">;
  /** Server-owned audit/report hook. Failures never close the observation socket. */
  onControlGap?: (gap: SharedDaemonControlGap) => void | Promise<void>;
  /** Makes the created instance available to the server reconciliation owner. */
  onTransport?: (transport: SharedDaemonCodexAppServerTransport) => void;
  timeoutMs?: number;
}
export interface SharedDaemonControlGap {
  sequence: number;
  threadId: string;
  eventMethod: string;
  disposition: "pending" | "owner" | "unknown";
}
const MAX_MESSAGE = 1024 * 1024;
const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 4 * MAX_MESSAGE;
const MAX_PENDING = 64;
const MAX_SERVER_REQUESTS = 32;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const idValid = (value: unknown): value is string | number =>
  (typeof value === "string" && value.length > 0 && value.length <= 256) ||
  (typeof value === "number" && Number.isSafeInteger(value));
const resumeConfigKeys = new Set([
  "skills.include_instructions", "include_apps_instructions", "include_collaboration_mode_instructions",
  "features.apps", "features.plugins", "features.multi_agent", "features.memories", "features.image_generation",
]);
const resumeKeys = new Set([
  "threadId", "excludeTurns", "cwd", "config", "permissions", "runtimeWorkspaceRoots",
  "baseInstructions", "developerInstructions", "approvalPolicy", "model", "dynamicTools",
  "conversationMode", "persistExtendedHistory",
]);
const observationalMethods = new Set(["initialize", "collaborationMode/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/goal/get"]);

/**
 * Opt-in transport to an existing daemon; close only releases this socket.
 * Provider-originated writes from other clients require a separate ingress fence.
 */
export class SharedDaemonCodexAppServerTransport implements CodexAppServerTransport {
  readonly #identity: Readonly<SharedDaemonIdentity>;
  readonly #admit: SharedDaemonTransportOptions["admit"];
  readonly #timeout: number;
  readonly #classifyIntervention: SharedDaemonTransportOptions["classifyIntervention"];
  readonly #onControlGap: SharedDaemonTransportOptions["onControlGap"];
  #socket: WebSocket | undefined;
  #connectPromise: Promise<void> | undefined;
  #closed = false;
  #failure: Error | undefined;
  #nextId = 0;
  #pending = new Map<number, {method: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout}>();
  #events: Array<{event: CodexRpcNotification; bytes: number}> = [];
  #eventBytes = 0;
  #waiters: Array<{resolve(value: IteratorResult<CodexRpcNotification>): void; reject(error: Error): void}> = [];
  #handler: CodexServerRequestHandler | undefined;
  #inflight = 0;
  #eventChain: Promise<void> = Promise.resolve();
  #reconciling = 0;
  #reconcilingBytes = 0;
  #gap: SharedDaemonControlGap | null = null;
  #gapSequence = 0;
  #classifications = 0;

  constructor(options: SharedDaemonTransportOptions) {
    const identity = options.identity;
    if (!isAbsolute(identity.codexHome) || !isAbsolute(identity.socketPath) || !isAbsolute(identity.workspace) ||
        ![identity.cliVersion, identity.appServerVersion, identity.processGeneration,
          identity.threadId, identity.model, identity.effort].every(v => typeof v === "string" && v.trim().length > 0) ||
        typeof options.admit !== "function") throw new Error("incomplete shared daemon identity or admission");
    this.#identity = Object.freeze({ ...identity, workspace: resolve(identity.workspace) });
    this.#admit = options.admit;
    this.#classifyIntervention = options.classifyIntervention;
    this.#onControlGap = options.onControlGap;
    this.#timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 120_000) throw new Error("invalid shared daemon timeout");
  }

  async #authorize(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#closed) throw this.#failure ?? new Error("shared daemon transport closed");
    if (!await this.#admit(this.#identity, { method, params })) throw new Error("shared daemon admission denied");
    if (this.#closed) throw this.#failure ?? new Error("shared daemon transport closed");
  }
  /** Snapshot is metadata only; event content stays on the normal notification stream. */
  controlGap(): SharedDaemonControlGap | null { return this.#gap ? { ...this.#gap } : null; }
  /** The issuer must verify durable source evidence and current writer authority. */
  async reconcileManagedWrites(evidence: Readonly<Record<string, unknown>>): Promise<void> {
    const sequence = this.#gap?.sequence;
    if (sequence === undefined) return;
    await this.#authorize("reconcile:managed-writes", { ...evidence, gapSequence: sequence });
    if (this.#gap?.sequence !== sequence) throw new Error("control gap changed during reconciliation");
    this.#gap = null;
  }
  #reportGap(): void {
    const gap = this.controlGap();
    if (gap && this.#onControlGap) void Promise.resolve().then(() => this.#onControlGap!(gap)).catch(() => {});
  }
  async #connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = (async () => {
      await this.#authorize("connect", {});
      const path = await realpath(this.#identity.socketPath);
      if (!(await stat(path)).isSocket()) throw new Error("shared daemon path is not a socket");
      await this.#authorize("connect", {});
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket("ws://localhost/", {
          createConnection: () => createConnection(path),
          maxPayload: MAX_MESSAGE,
          perMessageDeflate: false,
          handshakeTimeout: this.#timeout,
        });
        this.#socket = socket;
        socket.once("open", () => resolve());
        socket.on("message", (data, binary) => {
          try { if (binary) throw new Error("unexpected binary daemon message"); this.#message(data.toString()); }
          catch (error) { this.#fail(error instanceof Error ? error : new Error("invalid daemon message")); }
        });
        socket.on("error", () => { const error = new Error("shared daemon socket error; outcome may be unknown"); this.#fail(error); reject(error); });
        socket.on("close", () => { const error = new Error("shared daemon disconnected; outcome may be unknown"); this.#fail(error); reject(error); });
      });
    })();
    return this.#connectPromise;
  }
  #message(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { throw new Error("malformed daemon JSON"); }
    if (!record(msg)) throw new Error("invalid daemon message");
    const hasResult = Object.hasOwn(msg, "result"), hasError = Object.hasOwn(msg, "error");
    if (typeof msg.id === "number" && (hasResult || hasError)) {
      const pending = this.#pending.get(msg.id);
      if (!pending || hasResult === hasError) throw new Error("unknown or malformed daemon response");
      this.#pending.delete(msg.id); clearTimeout(pending.timer);
      if (hasError) pending.reject(new CodexRpcError("shared daemon RPC rejected", record(msg.error) && typeof msg.error.code === "number" ? msg.error.code : null));
      else if (record(msg.result)) {
        if ((pending.method === "thread/read" || pending.method === "thread/resume") &&
            (!record(msg.result.thread) || msg.result.thread.id !== this.#identity.threadId)) {
          const error = new Error("daemon returned a different thread; outcome may be unknown");
          pending.reject(error); throw error;
        }
        if ((pending.method === "thread/read" || pending.method === "thread/resume") &&
            (!record(msg.result.thread) || typeof msg.result.thread.cwd !== "string" ||
             !isAbsolute(msg.result.thread.cwd) || resolve(msg.result.thread.cwd) !== this.#identity.workspace)) {
          const error = new Error("daemon returned a different workspace; outcome may be unknown");
          pending.reject(error); throw error;
        }
        pending.resolve(msg.result);
      }
      else { const error = new Error("invalid daemon result; outcome may be unknown"); pending.reject(error); throw error; }
      return;
    }
    if (typeof msg.method !== "string" || !msg.method || hasResult || hasError || (msg.params !== undefined && !record(msg.params))) throw new Error("invalid daemon notification");
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.id !== undefined) {
      if (!idValid(msg.id)) throw new Error("invalid daemon request ID");
      const id = msg.id;
      // Never pass a request without exact thread evidence to a Paperclip handler.
      if (params.threadId !== this.#identity.threadId) return;
      if (!this.#handler || this.#inflight >= MAX_SERVER_REQUESTS) {
        this.#send({id, error:{code:-32001,message:"request not admitted"}}); return;
      }
      // Do not resolve another client's action while Paperclip lacks writer authority.
      if (this.#gap) return;
      this.#inflight++;
      void this.#authorize(`server:${msg.method}`, params)
        .then(() => this.#handler!({id,method:msg.method as string,params}))
        .then(async result => { await this.#authorize(`server:${msg.method}:resolve`, params); if (!this.#gap) this.#send({id,result}); }, () => { if (!this.#gap) this.#send({id,error:{code:-32001,message:"request not admitted"}}); })
        .catch(() => this.#fail(new Error("daemon request response failed")))
        .finally(() => { this.#inflight--; });
      return;
    }
    // Notifications with no thread identity cannot safely be attributed on a shared socket.
    if (params.threadId !== this.#identity.threadId) return;
    const event = {method:msg.method, params};
    const bytes = Buffer.byteLength(raw);
    if (this.#events.length + this.#reconciling >= MAX_EVENTS || this.#eventBytes + this.#reconcilingBytes + bytes > MAX_EVENT_BYTES) throw new Error("daemon event queue limit exceeded");
    this.#reconciling++; this.#reconcilingBytes += bytes;
    // Observation is never withheld while the issuer establishes event origin.
    // A provisional gap closes the write race while that check is in flight.
    if (event.method === "turn/started" || event.method === "thread/goal/updated" || event.method === "thread/goal/cleared") {
      const hadGap = this.#gap !== null;
      const sequence = ++this.#gapSequence;
      this.#gap = {sequence, threadId:this.#identity.threadId, eventMethod:event.method, disposition:"pending"};
      this.#reportGap();
      if (this.#classifications >= MAX_SERVER_REQUESTS) {
        this.#gap = {...this.#gap,disposition:"unknown"}; this.#reportGap();
      } else {
      this.#classifications++;
      void Promise.resolve().then(() => this.#admit(this.#identity, {method:`event:${event.method}`, params}))
        .then(async managed => {
          if (this.#gap?.sequence !== sequence) return;
          if (managed && !hadGap) { this.#gap = null; return; }
          const disposition = !managed && this.#classifyIntervention ? await this.#classifyIntervention(this.#identity,event) : "unknown";
          if (this.#gap?.sequence === sequence) { this.#gap = {...this.#gap,disposition}; this.#reportGap(); }
        }).catch(() => {
          if (this.#gap?.sequence === sequence) { this.#gap = {...this.#gap,disposition:"unknown"}; this.#reportGap(); }
        }).finally(() => { this.#classifications--; });
      }
    }
    // Preserve provider ordering behind any in-flight reconciliation.
    this.#eventChain = this.#eventChain.then(() => this.#deliver(event, bytes))
      .catch(() => this.#fail(new Error("daemon event queue limit exceeded")))
      .finally(() => { this.#reconciling--; this.#reconcilingBytes -= bytes; });
  }
  #deliver(event: CodexRpcNotification, bytes: number): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({value:event,done:false});
    else {
      if (this.#events.length >= MAX_EVENTS || this.#eventBytes + bytes > MAX_EVENT_BYTES) throw new Error("daemon event queue limit exceeded");
      this.#events.push({event,bytes}); this.#eventBytes += bytes;
    }
  }
  #send(value: unknown): void {
    const socket = this.#socket;
    if (this.#closed || !socket || socket.readyState !== WebSocket.OPEN) throw this.#failure ?? new Error("shared daemon disconnected");
    const payload = JSON.stringify(value), bytes = Buffer.byteLength(payload);
    if (bytes > MAX_MESSAGE || socket.bufferedAmount + bytes > MAX_EVENT_BYTES) throw new Error("daemon output limit exceeded");
    socket.send(payload, error => { if (error) this.#fail(new Error("daemon send failed; outcome may be unknown")); });
  }
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "thread/start") throw new Error("shared daemon requires exact thread resume");
    if (method !== "initialize" && method !== "collaborationMode/list" && params.threadId !== this.#identity.threadId) throw new Error("shared daemon thread mismatch");
    if (method === "thread/resume" && Object.keys(params).some(key => !resumeKeys.has(key))) throw new Error("shared daemon resume parameter not admitted");
    if (method === "thread/resume" && params.model !== undefined && params.model !== this.#identity.model) throw new Error("shared daemon model mismatch");
    if ((method === "thread/resume" || method === "turn/start") && params.cwd !== undefined &&
        (typeof params.cwd !== "string" || !isAbsolute(params.cwd) || resolve(params.cwd) !== this.#identity.workspace)) throw new Error("shared daemon workspace mismatch");
    if (method === "thread/resume" && params.config !== undefined &&
        (!record(params.config) || Object.entries(params.config).some(([key, value]) => !resumeConfigKeys.has(key) || typeof value !== "boolean"))) throw new Error("shared daemon resume config not admitted");
    if (method === "turn/start" && ((params.model !== undefined && params.model !== this.#identity.model) || (params.effort !== undefined && params.effort !== this.#identity.effort))) throw new Error("shared daemon model or effort mismatch");
    if (this.#gap && !observationalMethods.has(method)) throw new Error("managed writes held pending reconciliation");
    await this.#authorize(method, params); await this.#connect(); await this.#authorize(method, params);
    if (this.#gap && !observationalMethods.has(method)) throw new Error("managed writes held pending reconciliation");
    if (this.#pending.size >= MAX_PENDING) throw new Error("daemon pending request limit exceeded");
    const id = ++this.#nextId;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => this.#fail(new Error("daemon RPC timeout; outcome may be unknown")), this.#timeout);
      this.#pending.set(id,{method,resolve,reject,timer});
      try { this.#send({id,method,params}); } catch (error) { this.#pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params?: Record<string, unknown>): void {
    if (method !== "initialized") throw new Error("daemon notification not admitted");
    this.#send({method,...(params ? {params} : {})});
  }
  setServerRequestHandler(handler: CodexServerRequestHandler): void { this.#handler = handler; }
  notifications(): AsyncIterable<CodexRpcNotification> {
    return { [Symbol.asyncIterator]: () => ({next: () => {
      const item = this.#events.shift();
      if (item) { this.#eventBytes -= item.bytes; return Promise.resolve({value:item.event,done:false}); }
      if (this.#closed) return this.#failure ? Promise.reject(this.#failure) : Promise.resolve({value:undefined,done:true});
      return new Promise((resolve,reject) => this.#waiters.push({resolve,reject}));
    }}) };
  }
  #fail(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true; this.#failure = error; this.#socket?.terminate();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error ?? new Error("daemon closed; outcome may be unknown")); }
    this.#pending.clear(); this.#events = []; this.#eventBytes = 0;
    for (const waiter of this.#waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({value:undefined,done:true});
  }
  async close(): Promise<void> { this.#fail(); }
}

/** Uses the existing Codex driver's transportFactory and refuses new sessions. */
export function sharedDaemonTransportFactory(options: SharedDaemonTransportOptions): NonNullable<import("./codex-driver-types.js").CodexAppServerDriverOptions["transportFactory"]> {
  return context => {
    if (!context?.persistedSession || context.persistedSession.driverSessionId !== options.identity.threadId) throw new Error("shared daemon requires matching persisted session");
    const transport = new SharedDaemonCodexAppServerTransport(options);
    options.onTransport?.(transport);
    return transport;
  };
}
