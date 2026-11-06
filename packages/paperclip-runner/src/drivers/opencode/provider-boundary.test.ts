import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { OpenCodeProviderBoundary } from "./provider-boundary.js";
import { startOpenCodeProviderProxy } from "./opencode-server-driver.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });

async function engine(port = 0) {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString());
    const message = requests.length === 1
      ? { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }
      : { role: "assistant", content: "done" };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  return { server, port: (server.address() as { port: number }).port, requests };
}

const next = JSON.stringify({ model: "model", messages: [
  { role: "user", content: "task" },
  { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call-1", content: "tool result" },
], temperature: 0, stream: false });

it("holds the complete next tool turn across an engine restart and sends identical full history for prefill", async () => {
  const first = await engine();
  const boundary = new OpenCodeProviderBoundary();
  const proxy = await startOpenCodeProviderProxy(`http://127.0.0.1:${first.port}/v1`, "", "model", {}, undefined, boundary);
  const send = (body: string) => fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body });
  try {
    const firstResponse = await send(JSON.stringify({ model: "model", messages: [{ role: "user", content: "task" }] }));
    expect(firstResponse.status).toBe(200);
    const assistant = (await firstResponse.json() as { choices: Array<{ message: unknown }> }).choices[0]!.message;
    expect(assistant).toEqual(JSON.parse(next).messages[1]);
    const frozen = boundary.freeze({ timeoutMs: 3000, signal: new AbortController().signal });
    const continuation = send(next);
    const checkpoint = await frozen;
    expect(checkpoint.requestSha256).toBe(createHash("sha256").update(next).digest("hex"));
    expect(first.requests).toHaveLength(1);
    expect(() => boundary.resume({ ...checkpoint, requestSha256: "wrong" })).toThrow("checkpoint_mismatch");
    await new Promise<void>(resolve => first.server.close(() => resolve()));
    const restarted = await engine(first.port);
    boundary.resume(checkpoint);
    expect((await continuation).status).toBe(200);
    expect(restarted.requests).toEqual([next]);
  } finally { await proxy.close(); }
});

it("fails closed for incomplete tool batches, concurrent requests and lost held requests", async () => {
  const boundary = new OpenCodeProviderBoundary();
  const freeze = boundary.freeze({ timeoutMs: 3000, signal: new AbortController().signal });
  const controller = new AbortController();
  const invalid = Buffer.from(JSON.stringify({ messages: [{ role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] }, { role: "tool", tool_call_id: "a" }] }));
  const release = await boundary.enter(invalid, JSON.parse(invalid.toString()), controller.signal);
  release();
  const held = boundary.enter(Buffer.from(next), JSON.parse(next), controller.signal);
  const checkpoint = await freeze;
  controller.abort();
  await expect(held).rejects.toThrow();
  expect(() => boundary.resume(checkpoint)).toThrow("checkpoint_mismatch");
  boundary.close();
});

it("reports an engine failure without replaying the held request", async () => {
  const original = await engine();
  const boundary = new OpenCodeProviderBoundary();
  const proxy = await startOpenCodeProviderProxy(`http://127.0.0.1:${original.port}/v1`, "", "model", {}, undefined, boundary);
  try {
    const frozen = boundary.freeze({ timeoutMs: 3000, signal: new AbortController().signal });
    const request = fetch(`${proxy.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}` }, body: next });
    const checkpoint = await frozen;
    await new Promise<void>(resolve => original.server.close(() => resolve()));
    boundary.resume(checkpoint);
    expect((await request).status).toBe(502);
    const restarted = await engine(original.port);
    expect(restarted.requests).toEqual([]);
  } finally { await proxy.close(); }
});

it("terminates on cancellation, deadline, or concurrent work at the boundary", async () => {
  const signal = new AbortController();
  const cancelled = new OpenCodeProviderBoundary();
  const waiting = cancelled.freeze({ timeoutMs: 3000, signal: signal.signal });
  signal.abort();
  await expect(waiting).rejects.toThrow("cancelled");
  await expect(cancelled.enter(Buffer.from(next), JSON.parse(next), new AbortController().signal)).rejects.toThrow("closed");

  const timed = new OpenCodeProviderBoundary();
  const deadline = timed.freeze({ timeoutMs: 10, signal: new AbortController().signal });
  const held = timed.enter(Buffer.from(next), JSON.parse(next), new AbortController().signal);
  const checkpoint = await deadline;
  await expect(held).rejects.toThrow("deadline");
  expect(() => timed.resume(checkpoint)).toThrow("checkpoint_mismatch");

  const concurrent = new OpenCodeProviderBoundary();
  const active = await concurrent.enter(Buffer.from("{}"), {}, new AbortController().signal);
  const freeze = concurrent.freeze({ timeoutMs: 3000, signal: new AbortController().signal });
  const rejected = expect(freeze).rejects.toThrow("concurrent");
  await expect(concurrent.enter(Buffer.from(next), JSON.parse(next), new AbortController().signal)).rejects.toThrow("concurrent");
  await rejected;
  active();
});
