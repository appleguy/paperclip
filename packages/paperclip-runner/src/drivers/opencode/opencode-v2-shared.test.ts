import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeV2Shared, type V2Authority, type V2Binding, type V2Cursor } from "./opencode-v2-shared.js";

const binding: V2Binding = { sessionId: "ses_one", generation: "boot-one", version: "2.2.5" };
function fixture() {
  let cursor: V2Cursor | null = null;
  const operations = new Map<string, string>();
  const events: unknown[] = [];
  let currentGeneration = binding.generation;
  const authority: V2Authority = {
    attest: async (b) => { if (b.generation !== currentGeneration) throw new Error("stale generation"); },
    withMutation: async (_b, operation, send) => {
      const old = operations.get(operation.id);
      if (old && old !== operation.digest) throw new Error("operation conflict");
      operations.set(operation.id, operation.digest);
      return send();
    },
    loadCursor: async () => cursor,
    commitLog: async (b, previous, next, item) => {
      if (b.generation !== currentGeneration || (cursor?.seq ?? null) !== previous) throw new Error("stale commit");
      events.push(item); cursor = { ...b, seq: next };
    },
  };
  return { authority, events, operations, setCursor: (v: V2Cursor) => { cursor = v; }, generation: (v: string) => { currentGeneration = v; } };
}
const event = (n: number, session = binding.sessionId) => ({ id: `evt_${n}`, type: "session.execution.started", created: 1, data: { sessionID: session }, durable: { aggregateID: session, seq: n, version: 1 } });
const marker = (n: number) => ({ type: "log.synced", aggregateID: binding.sessionId, seq: n });
function sse(items: unknown[]) {
  const bytes = new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 4096) c.enqueue(bytes.subarray(i, i + 4096)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
function controller(authority: V2Authority, fetcher: typeof fetch) { return new OpenCodeV2Shared({ baseUrl: "http://localhost:4096/", binding, authority, headers: { authorization: "Bearer test" }, fetch: fetcher }); }
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
type WorldOptions = {
  sessionAgent?: string | null;
  messages?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  messageData?: unknown;
  agentData?: unknown;
  pinApplies?: boolean;
  pinStatus?: number;
};
/** Stateful session fixture: the pin POST mutates session.agent unless pinApplies is false. */
function world(options: WorldOptions = {}) {
  const session: Record<string, unknown> = { id: "ses_one", agent: options.sessionAgent === undefined ? null : options.sessionAgent };
  const requests: Array<{ method: string; target: string; body: string }> = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const target = parsed.pathname + parsed.search;
    const body = String(init?.body ?? "");
    const method = String(init?.method ?? "GET");
    requests.push({ method, target, body });
    if (method === "GET" && target === "/api/session/ses_one") return Response.json({ data: session });
    if (method === "GET" && target === "/api/session/ses_one/message?type=assistant&limit=20&order=desc") return Response.json({ cursor: null, data: options.messageData === undefined ? options.messages ?? [] : options.messageData });
    if (method === "GET" && target === "/api/agent") return Response.json({ data: options.agentData === undefined ? options.agents ?? [] : options.agentData });
    if (method === "POST" && target === "/api/session/ses_one/agent") {
      if (options.pinStatus && options.pinStatus !== 204) return new Response("pin failed", { status: options.pinStatus });
      if (options.pinApplies !== false) session.agent = (JSON.parse(body) as { agent: string }).agent;
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST" && target === "/api/session/ses_one/prompt") {
      const sent = JSON.parse(body) as { id: string };
      return Response.json({ data: { id: sent.id, sessionID: "ses_one", type: "user" } });
    }
    throw new Error(`unexpected request ${init?.method} ${target}`);
  }) as unknown as typeof fetch;
  return { session, requests, fetcher };
}
const primaries = [{ id: "build", mode: "primary" }, { id: "plan", mode: "primary" }, { id: "general", mode: "subagent" }];

describe("OpenCode 2.2.5 shared transport", () => {
  it("retries an unknown prompt acknowledgement with the identical durable message id, rejecting changed content", async () => {
    const f = fixture(); let calls = 0;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return String(url).includes("/message?") ? Response.json({ data: [] }) : Response.json({ data: { id: "ses_one" } });
      calls++; if (calls === 1) throw new Error("lost response");
      expect(JSON.parse(String(init?.body))).toEqual({ id: "msg_one", text: "hello" });
      return Response.json({ data: { id: "msg_one", sessionID: "ses_one", type: "user" } });
    }) as unknown as typeof fetch;
    const c = controller(f.authority, fetcher);
    await expect(c.prompt({ id: "msg_one", text: "hello" })).rejects.toThrow("lost response");
    await c.prompt({ id: "msg_one", text: "hello" });
    await expect(c.prompt({ id: "msg_one", text: "changed" })).rejects.toThrow("operation conflict");
    expect(calls).toBe(2);
  });
  it("replays fragmented durable events including external activity and resumes at the exclusive cursor", async () => {
    const f = fixture(); const urls: string[] = [];
    const fetcher = vi.fn(async (url: unknown) => { urls.push(String(url)); return urls.length === 1 ? sse([event(2), marker(2), event(3)]) : sse([marker(3)]); }) as unknown as typeof fetch;
    const c = controller(f.authority, fetcher);
    await expect(c.follow()).rejects.toThrow("disconnected"); await expect(c.follow()).rejects.toThrow("disconnected");
    expect(urls[0]).toContain("follow=true"); expect(urls[1]).toContain("after=3");
    expect(f.events).toEqual([event(2), marker(2), event(3), marker(3)]);
  });
  it("rejects stale generations and foreign session events before cursor commit", async () => {
    const f = fixture(); const c = controller(f.authority, vi.fn(async () => sse([event(1, "ses_other")])) as unknown as typeof fetch);
    await expect(c.follow()).rejects.toThrow("event identity"); expect(f.events).toHaveLength(0);
    f.setCursor({ ...binding, generation: "old", seq: 2 }); await expect(c.follow()).rejects.toThrow("cursor binding");
    f.setCursor({ ...binding, seq: 2 }); f.generation("new"); await expect(c.follow()).rejects.toThrow("stale generation");
  });
  it("fails closed on authentication and mismatched session or prompt receipts", async () => {
    const f = fixture(); const unauthorized = controller(f.authority, vi.fn(async () => new Response("secret detail", { status: 401 })) as unknown as typeof fetch);
    await expect(unauthorized.verifySession()).rejects.toThrow("HTTP 401");
    const wrong = controller(f.authority, vi.fn(async () => Response.json({ data: { id: "ses_other" } })) as unknown as typeof fetch);
    await expect(wrong.verifySession()).rejects.toThrow("identity mismatch");
    const badReceipt = controller(f.authority, vi.fn(async (url: unknown, init?: RequestInit) => init?.method === "POST" ? Response.json({ data: { id: "msg_foreign", sessionID: "ses_one", type: "user" } }) : String(url).includes("/message?") ? Response.json({ data: [] }) : Response.json({ data: { id: "ses_one" } })) as unknown as typeof fetch);
    await expect(badReceipt.prompt({ id: "msg_one", text: "x" })).rejects.toThrow("receipt identity mismatch");
  });
  it("requires authorization and snapshots headers, binding, and request options", async () => {
    const f = fixture();
    expect(() => new OpenCodeV2Shared({ baseUrl: "http://localhost/", binding, authority: f.authority, headers: {} })).toThrow("authorization required");
    const headers = { authorization: "Bearer original" };
    const mutable = { ...binding };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer original");
      return Response.json({ data: { id: "ses_one" } });
    }) as unknown as typeof fetch;
    const c = new OpenCodeV2Shared({ baseUrl: "http://localhost/", binding: mutable, authority: f.authority, headers, fetch: fetcher });
    headers.authorization = "Bearer changed"; mutable.sessionId = "ses_other";
    await c.verifySession();
  });
  it("bounds prompt and JSON response and refuses HTML fallback", async () => {
    const f = fixture();
    const html = controller(f.authority, vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch);
    await expect(html.verifySession()).rejects.toThrow("JSON response");
    const big = controller(f.authority, vi.fn(async () => new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    await expect(big.verifySession()).rejects.toThrow("too large");
    await expect(big.prompt({ id: "msg_big", text: "x".repeat(262_145) })).rejects.toThrow("prompt too large");
  });
  it("refuses an oversized durable log frame without advancing its cursor", async () => {
    const f = fixture();
    const c = controller(f.authority, vi.fn(async () => sse([{ ...event(1), data: { sessionID: "ses_one", text: "x".repeat(1_100_000) } }])) as unknown as typeof fetch);
    await expect(c.follow()).rejects.toThrow("frame truncated");
    expect(f.events).toHaveLength(0);
  });

  it("does not advance an uncommitted event or accept an unsynchronized stream", async () => {
    const f = fixture(); const c = controller(f.authority, vi.fn(async () => sse([event(1)])) as unknown as typeof fetch);
    await expect(c.follow()).rejects.toThrow("before synchronization");
    expect(f.events).toHaveLength(1);
  });
  it("resolves a null-agent session from its newest assistant and pins before the prompt", async () => {
    const f = fixture();
    const w = world({ agents: primaries, messages: [{ type: "user", agent: "" }, { type: "assistant", agent: "plan" }] });
    const c = controller(f.authority, w.fetcher);
    await c.prompt({ id: "msg_implicit", text: "steer me" });
    expect(w.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      "GET /api/session/ses_one",
      "GET /api/session/ses_one/message?type=assistant&limit=20&order=desc",
      "GET /api/agent",
      "POST /api/session/ses_one/agent",
      "GET /api/session/ses_one",
      "POST /api/session/ses_one/prompt",
    ]);
    expect(JSON.parse(w.requests[3].body)).toEqual({ agent: "plan" });
    expect(JSON.parse(w.requests[5].body)).toEqual({ id: "msg_implicit", text: "steer me" });
    expect(w.session.agent).toBe("plan");
    expect(f.operations.get("msg_implicit")).toBe(sha256(JSON.stringify({ id: "msg_implicit", text: "steer me" })));
  });
  it("prefers an explicit agent, folds it into the digest, and conflicts on drift", async () => {
    const f = fixture();
    const w = world({ sessionAgent: "build", agents: primaries });
    const c = controller(f.authority, w.fetcher);
    await c.prompt({ id: "msg_explicit", text: "hi", agent: "build" });
    expect(w.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      "GET /api/session/ses_one",
      "GET /api/agent",
      "POST /api/session/ses_one/agent",
      "GET /api/session/ses_one",
      "POST /api/session/ses_one/prompt",
    ]);
    expect(f.operations.get("msg_explicit")).toBe(sha256(JSON.stringify({ id: "msg_explicit", text: "hi" }) + "\u0000agent\u0000build"));
    await expect(c.prompt({ id: "msg_explicit", text: "hi", agent: "plan" })).rejects.toThrow("operation conflict");
    expect(w.requests.filter((r) => r.target === "/api/session/ses_one/prompt")).toHaveLength(1);
  });
  it("sends a fresh no-agent first turn without resolving or pinning", async () => {
    const f = fixture();
    const w = world({ agents: primaries, messages: [] });
    const c = controller(f.authority, w.fetcher);
    await c.prompt({ id: "msg_fresh", text: "first" });
    expect(w.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      "GET /api/session/ses_one",
      "GET /api/session/ses_one/message?type=assistant&limit=20&order=desc",
      "POST /api/session/ses_one/prompt",
    ]);
    expect(f.operations.get("msg_fresh")).toBe(sha256(JSON.stringify({ id: "msg_fresh", text: "first" })));
  });
  it("resolves the session's stored agent without reading messages", async () => {
    const f = fixture();
    const w = world({ sessionAgent: "build", agents: primaries, messages: [{ type: "assistant", agent: "plan" }] });
    const c = controller(f.authority, w.fetcher);
    await c.prompt({ id: "msg_record", text: "go" });
    expect(w.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      "GET /api/session/ses_one",
      "GET /api/agent",
      "POST /api/session/ses_one/agent",
      "GET /api/session/ses_one",
      "POST /api/session/ses_one/prompt",
    ]);
    expect(JSON.parse(w.requests[2].body)).toEqual({ agent: "build" });
  });
  it("skips agentless newer entries and pins the older assistant's agent", async () => {
    const f = fixture();
    const w = world({ agents: primaries, messages: [{ type: "assistant", agent: "" }, { type: "user", agent: "" }, { type: "assistant", agent: "plan" }] });
    const c = controller(f.authority, w.fetcher);
    await c.prompt({ id: "msg_skip", text: "go" });
    expect(w.requests.map((r) => `${r.method} ${r.target}`)).toEqual([
      "GET /api/session/ses_one",
      "GET /api/session/ses_one/message?type=assistant&limit=20&order=desc",
      "GET /api/agent",
      "POST /api/session/ses_one/agent",
      "GET /api/session/ses_one",
      "POST /api/session/ses_one/prompt",
    ]);
    expect(JSON.parse(w.requests[3].body)).toEqual({ agent: "plan" });
  });
  it("fails closed when the pin response is an error or the read-back does not confirm", async () => {
    const f1 = fixture();
    const w1 = world({ agents: primaries, messages: [{ type: "assistant", agent: "plan" }], pinStatus: 500 });
    await expect(controller(f1.authority, w1.fetcher).prompt({ id: "msg_pin500", text: "go" })).rejects.toThrow("HTTP 500");
    expect(w1.requests.filter((r) => r.target === "/api/session/ses_one/prompt")).toHaveLength(0);
    const f2 = fixture();
    const w2 = world({ agents: primaries, messages: [{ type: "assistant", agent: "plan" }], pinApplies: false });
    await expect(controller(f2.authority, w2.fetcher).prompt({ id: "msg_pinstale", text: "go" })).rejects.toThrow("pin not confirmed");
    expect(w2.requests.filter((r) => r.target === "/api/session/ses_one/prompt")).toHaveLength(0);
    expect(w2.session.agent).toBeNull();
  });
  it("refuses a resolved subagent or unknown explicit agent without any POST", async () => {
    const f1 = fixture();
    const w1 = world({ agents: primaries, messages: [{ type: "assistant", agent: "general" }] });
    await expect(controller(f1.authority, w1.fetcher).prompt({ id: "msg_sub", text: "go" })).rejects.toThrow("not a primary agent");
    expect(w1.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    const f2 = fixture();
    const w2 = world({ agents: primaries });
    await expect(controller(f2.authority, w2.fetcher).prompt({ id: "msg_ghost", text: "go", agent: "ghost" })).rejects.toThrow("not a primary agent");
    expect(w2.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  it("fails closed on malformed message or agent list responses without any POST", async () => {
    const f1 = fixture();
    const w1 = world({ messageData: {} });
    await expect(controller(f1.authority, w1.fetcher).prompt({ id: "msg_badlist", text: "go" })).rejects.toThrow("Invalid OpenCode message response");
    expect(w1.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    const f2 = fixture();
    const w2 = world({ agentData: {} });
    await expect(controller(f2.authority, w2.fetcher).prompt({ id: "msg_badagents", text: "go", agent: "build" })).rejects.toThrow("Invalid OpenCode agent response");
    expect(w2.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
});
