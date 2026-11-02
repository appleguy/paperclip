import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOpenCodeBoundFetch } from "./opencode-bound-fetch.js";

(process.platform === "darwin" ? describe : describe.skip)("OpenCode connection-bound HTTP", () => {
  it("sends credentials only after the kernel identifies the listener on the same socket", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(req.headers.authorization ?? ""); res.end("ok"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const fetch = createOpenCodeBoundFetch({ pid: process.pid, port, isAlive: () => true });
      expect(await (await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: "fixture" } })).text()).toBe("ok");
      expect(seen).toEqual(["fixture"]);
      const foreign = createOpenCodeBoundFetch({ pid: 2147483647, port, isAlive: () => true });
      await expect(foreign(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: "must-not-send" } })).rejects.toThrow();
      expect(seen).toEqual(["fixture"]);
      await expect(fetch(`http://localhost:${port}/api/info`)).rejects.toThrow("target_invalid");
      await expect(fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST", body: "{}" })).rejects.toThrow("target_invalid");
      const create = createOpenCodeBoundFetch({ pid: process.pid, port, isAlive: () => true, allowEmptySessionCreate: true });
      await expect(create(`http://127.0.0.1:${port}/api/session`, { method: "POST", body: '{"prompt":"no"}' })).rejects.toThrow("target_invalid");
      await expect(create(`http://127.0.0.1:${port}/api/session/ses_x/prompt`, { method: "POST", body: "{}" })).rejects.toThrow("target_invalid");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
