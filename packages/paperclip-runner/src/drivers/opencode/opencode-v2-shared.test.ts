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

describe("OpenCode 2.2.5 shared transport", () => {
  it("retries an unknown prompt acknowledgement with the identical durable message id, rejecting changed content", async () => {
    const f = fixture(); let calls = 0;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ data: { id: "ses_one" } });
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
    const badReceipt = controller(f.authority, vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? Response.json({ data: { id: "msg_foreign", sessionID: "ses_one", type: "user" } }) : Response.json({ data: { id: "ses_one" } })) as unknown as typeof fetch);
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
});
