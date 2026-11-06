import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { OpenCodeHttpDriver } from "./opencode-http-driver.js";

function driver(inbox: Response, message: Response) {
  const fetchImpl = async (input: string | URL | Request) =>
    String(input).endsWith("/inbox") ? inbox : message;
  return new OpenCodeHttpDriver({ url: "http://localhost:4096", passwordFile: fileURLToPath(import.meta.url), fetchImpl: fetchImpl as typeof fetch });
}
const json = (data: unknown, status = 200) => Response.json(data, { status });

describe("original message lookup", () => {
  it("finds an exact queued message without consulting history", async () => {
    expect(await driver(json({ data: [{ id: "msg_target" }] }), json({}, 500))
      .messageExists("ses_test", "msg_target")).toBe(true);
  });

  it("confirms absence only when both inbox and message history are readable", async () => {
    expect(await driver(json({ data: [] }), json({}, 404)).messageExists("ses_test", "msg_target")).toBe(false);
    expect(await driver(json({ data: [] }), json({ data: { id: "msg_target", type: "user" } }))
      .messageExists("ses_test", "msg_target")).toBe(true);
  });

  it.each([
    [json({}, 503), json({}, 404)],
    [json({ data: [{}] }), json({}, 404)],
    [json({ data: [] }), json({}, 503)],
    [json({ data: [] }), json({ data: { id: "msg_other", type: "user" } })],
  ])("holds on unreadable or mismatched provider state", async (inbox, message) => {
    await expect(driver(inbox, message).messageExists("ses_test", "msg_target")).rejects.toThrow();
  });
});
