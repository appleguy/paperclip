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
      const interrupt = createOpenCodeBoundFetch({ pid: process.pid, port, isAlive: () => true, allowInterruptForSession: "ses_owned" });
      expect(await (await interrupt(`http://127.0.0.1:${port}/api/session/ses_owned/interrupt`, { method: "POST" })).text()).toBe("ok");
      await expect(interrupt(`http://127.0.0.1:${port}/api/session/ses_other/interrupt`, { method: "POST" })).rejects.toThrow("target_invalid");
      await expect(interrupt(`http://127.0.0.1:${port}/api/session/ses_owned/interrupt?all=true`, { method: "POST" })).rejects.toThrow("target_invalid");
      await expect(interrupt(`http://127.0.0.1:${port}/api/session/ses_owned/interrupt`, { method: "POST", body: "{}" })).rejects.toThrow("target_invalid");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("forwards only a verified agent pin body for the allowed session", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => { seen.push({ method: req.method ?? "", url: req.url ?? "", body }); res.statusCode = 204; res.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const fetch = createOpenCodeBoundFetch({ pid: process.pid, port, isAlive: () => true, allowAgentPinForSession: "ses_owned" });
      const url = (path: string) => `http://127.0.0.1:${port}${path}`;
      expect((await fetch(url("/api/session/ses_owned/agent"), { method: "POST", body: '{"agent":"plan"}' })).status).toBe(204);
      expect(seen).toEqual([{ method: "POST", url: "/api/session/ses_owned/agent", body: '{"agent":"plan"}' }]);
      const rejected: Array<[string, RequestInit]> = [
        ["/api/session/ses_other/agent", { method: "POST", body: '{"agent":"plan"}' }],
        ["/api/session/ses_owned/agent?force=true", { method: "POST", body: '{"agent":"plan"}' }],
        ["/api/session/ses_owned/agent", { method: "POST", body: '{"agent":""}' }],
        ["/api/session/ses_owned/agent", { method: "POST", body: '{"agent":"plan","extra":1}' }],
        ["/api/session/ses_owned/agent", { method: "POST", body: '{"model":"plan"}' }],
        ["/api/session/ses_owned/agent", { method: "POST", body: "not json" }],
        ["/api/session/ses_owned/agent", { method: "POST", body: "" }],
      ];
      for (const [path, init] of rejected) await expect(fetch(url(path), init)).rejects.toThrow("target_invalid");
      const plain = createOpenCodeBoundFetch({ pid: process.pid, port, isAlive: () => true });
      await expect(plain(url("/api/session/ses_owned/agent"), { method: "POST", body: '{"agent":"plan"}' })).rejects.toThrow("target_invalid");
      expect(seen).toEqual([{ method: "POST", url: "/api/session/ses_owned/agent", body: '{"agent":"plan"}' }]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
