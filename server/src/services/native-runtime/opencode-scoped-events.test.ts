import { expect, it, vi } from "vitest";
import { scopedOpenCodeEvents } from "./opencode-scoped-events.js";

it("projects only exact-session metadata, reattests and never forwards foreign or RPC payloads", async () => {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const events = [
    { id: "1", created: 1, type: "session.renamed", data: { sessionID: "ses_foreign", title: "foreign secret" } },
    { id: "2", created: 2, type: "plugin.rpc", data: { sessionID: "ses_owned", secret: "rpc secret" } },
    { id: "3", created: 3, type: "session.created", location: { directory: "/other" }, data: { sessionID: "ses_owned", location: { directory: "/other" }, slug: "s", version: "v", projectID: "p", subpath: "" } },
    { id: "4", created: 4, type: "session.renamed", data: { sessionID: "ses_owned", title: "safe", secret: "discard" }, secret: "discard" },
  ];
  const bytes = new TextEncoder().encode(events.map(frame).join(""));
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); } });
  const attest = vi.fn(async () => {});
  const result = await new Response(scopedOpenCodeEvents(upstream, "ses_owned", "/work", attest)).text();
  expect(result).toBe(frame({ id: "4", created: 4, type: "session.renamed", data: { sessionID: "ses_owned", title: "safe" } }));
  expect(attest).toHaveBeenCalledTimes(1);
});

it("fails the stream on lost authority without releasing an event", async () => {
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":"1","created":1,"type":"session.renamed","data":{"sessionID":"ses_owned","title":"safe"}}\n\n')); controller.close(); } });
  await expect(new Response(scopedOpenCodeEvents(upstream, "ses_owned", "/work", async () => { throw new Error("lease_lost"); })).text()).rejects.toThrow("lease_lost");
});

it("handles UTF-8 and CRLF separators split across network chunks", async () => {
  const bytes = new TextEncoder().encode('data: {"id":"1","created":1,"type":"session.renamed","data":{"sessionID":"ses_owned","title":"café"}}\r\n\r\n');
  const accent = bytes.indexOf(0xc3), cr = bytes.lastIndexOf(0x0d);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const slice of [bytes.slice(0, accent + 1), bytes.slice(accent + 1, cr + 1), bytes.slice(cr + 1)]) controller.enqueue(slice); controller.close(); } });
  const result = await new Response(scopedOpenCodeEvents(stream, "ses_owned", "/work", async () => {})).text();
  expect(result).toContain('"title":"café"');
});

it("projects only an empty native connection envelope after attestation", async () => {
  const payload = ['data: {"id":"connected","type":"server.connected","data":{}}', 'data: {"id":"foreign","type":"server.connected","data":{"secret":"no"}}'].join("\n\n") + "\n\n";
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } });
  const attest = vi.fn(async () => {});
  expect(await new Response(scopedOpenCodeEvents(stream, "ses_owned", "/work", attest)).text()).toBe('data: {"id":"connected","type":"server.connected","data":{}}\n\n');
  expect(attest).toHaveBeenCalledTimes(1);
});
