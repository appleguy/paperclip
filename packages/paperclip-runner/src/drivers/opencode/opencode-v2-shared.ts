import { createHash } from "node:crypto";
import { parseOpenCodeSseFrames } from "./sse-frames.js";

/** This transport is opt-in and has no default persistence or authority. */
export type V2Binding = Readonly<{ sessionId: string; generation: string; version: "2.2.5" }>;
export type V2Cursor = V2Binding & { seq: number | null };
export type V2Event = Record<string, unknown>;
export interface V2Authority {
  /** Verify the current authenticated server generation and exact version before each request. */
  attest(binding: V2Binding): Promise<void>;
  /** Atomically serialize Runner mutations for this session, persist id/digest before send,
   * reject a reused id with another digest, and retain unresolved operations after errors. */
  withMutation<T>(binding: V2Binding, operation: { id: string; digest: string }, send: () => Promise<T>): Promise<T>;
  loadCursor(binding: V2Binding): Promise<V2Cursor | null>;
  /** Atomically apply the exact event or synchronization marker and persist its cursor.
   * Must reject stale generations and concurrent cursor changes. Events include external activity. */
  commitLog(binding: V2Binding, previous: number | null, next: number | null, item: V2Event): Promise<void>;
}

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OpenCode v2 response");
  return value as Record<string, unknown>;
}
function seq(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
const MAX_JSON_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 262_144;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) throw new Error("Invalid OpenCode JSON response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error("OpenCode JSON response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function id(value: string, prefix: string): boolean { return value.startsWith(prefix) && value.length > prefix.length; }

export class OpenCodeV2Shared {
  readonly #url: URL;
  readonly #binding: V2Binding;
  readonly #authority: V2Authority;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  constructor(input: { baseUrl: string; binding: V2Binding; authority: V2Authority; headers: Record<string, string>; fetch?: typeof fetch }) {
    this.#url = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(this.#url.protocol) || (this.#url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(this.#url.hostname)) || this.#url.username || this.#url.password || this.#url.search || this.#url.hash || this.#url.pathname !== '/') throw new Error("Invalid OpenCode server origin");
    if (input.binding.version !== "2.2.5" || !id(input.binding.sessionId, "ses_") || !input.binding.generation) throw new Error("Invalid OpenCode v2 binding");
    this.#binding = Object.freeze({ ...input.binding });
    const authority = input.authority;
    this.#authority = Object.freeze({
      attest: authority.attest.bind(authority),
      withMutation: authority.withMutation.bind(authority),
      loadCursor: authority.loadCursor.bind(authority),
      commitLog: authority.commitLog.bind(authority),
    });
    const headers = new Headers(input.headers);
    if (!headers.get("authorization")?.trim()) throw new Error("OpenCode authorization required");
    this.#headers = Object.freeze(Object.fromEntries(headers.entries()));
    this.#fetch = input.fetch ?? globalThis.fetch;
  }
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.#authority.attest(this.#binding);
    const headers = new Headers(this.#headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await this.#fetch(new URL(path, this.#url), { ...init, headers, redirect: "error" });
    if (!response.ok) throw new Error(`OpenCode v2 HTTP ${response.status}`);
    return response;
  }
  async verifySession(): Promise<void> {
    const response = await this.#request(`/api/session/${encodeURIComponent(this.#binding.sessionId)}`);
    if (obj(obj(await boundedJson(response)).data).id !== this.#binding.sessionId) throw new Error("OpenCode session identity mismatch");
  }
  async prompt(input: { id: string; text: string; delivery?: "steer" | "queue"; resume?: boolean }): Promise<void> {
    if (!id(input.id, "msg_") || typeof input.text !== "string" || (input.delivery !== undefined && input.delivery !== "steer" && input.delivery !== "queue") || (input.resume !== undefined && typeof input.resume !== "boolean")) throw new Error("Invalid OpenCode prompt identity");
    if (Buffer.byteLength(input.text, "utf8") > MAX_PROMPT_BYTES) throw new Error("OpenCode prompt too large");
    const body = JSON.stringify({ id: input.id, text: input.text, ...(input.delivery === undefined ? {} : { delivery: input.delivery }), ...(input.resume === undefined ? {} : { resume: input.resume }) });
    const digest = createHash("sha256").update(body).digest("hex");
    await this.#authority.withMutation(this.#binding, { id: input.id, digest }, async () => {
      await this.verifySession();
      const response = await this.#request(`/api/session/${encodeURIComponent(this.#binding.sessionId)}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const item = obj(obj(await boundedJson(response)).data);
      if (item.id !== input.id || item.sessionID !== this.#binding.sessionId || item.type !== "user") throw new Error("OpenCode prompt receipt identity mismatch");
    });
  }
  /** Consume durable events, including other clients' turns. Never treats observation as ownership. */
  async follow(signal?: AbortSignal): Promise<void> {
    const cursor = await this.#authority.loadCursor(this.#binding);
    if (cursor && (cursor.sessionId !== this.#binding.sessionId || cursor.generation !== this.#binding.generation || cursor.version !== this.#binding.version || (cursor.seq !== null && !seq(cursor.seq)))) throw new Error("OpenCode cursor binding mismatch");
    let previous = cursor?.seq ?? null;
    const query = new URLSearchParams({ follow: "true" });
    if (previous !== null) query.set("after", String(previous));
    const response = await this.#request(`/api/experimental/session/${encodeURIComponent(this.#binding.sessionId)}/log?${query}`, { headers: { accept: "text/event-stream" }, signal });
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new Error("Invalid OpenCode log stream");
    let synchronized = false;
    for await (const frame of parseOpenCodeSseFrames(response.body)) {
      if (frame.compaction) throw new Error("OpenCode durable log frame truncated");
      const item = obj(JSON.parse(frame.data));
      let next: number | null;
      if (item.type === "log.synced") {
        if (synchronized || item.aggregateID !== this.#binding.sessionId || (item.seq !== undefined && !seq(item.seq))) throw new Error("Invalid OpenCode log watermark");
        next = item.seq === undefined ? null : item.seq as number;
        if ((previous !== null && next === null) || (previous !== null && next !== null && next < previous)) throw new Error("OpenCode log watermark regressed");
        synchronized = true;
      } else {
        const durable = obj(item.durable);
        const data = obj(item.data);
        if (durable.aggregateID !== this.#binding.sessionId || data.sessionID !== this.#binding.sessionId || !seq(durable.seq) || typeof item.type !== "string" || !id(String(item.id ?? ""), "evt_") || !Number.isSafeInteger(durable.version) || (durable.version as number) < 1) throw new Error("Invalid OpenCode durable event identity");
        next = durable.seq;
        if (previous !== null && next <= previous) throw new Error("OpenCode log sequence regressed");
      }
      await this.#authority.commitLog(this.#binding, previous, next, item);
      previous = next;
    }
    if (!synchronized) throw new Error("OpenCode log ended before synchronization");
    throw new Error("OpenCode log disconnected; reconnect from committed cursor");
  }
}
