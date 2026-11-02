import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startOpenCodeProviderProxy } from "./opencode-server-driver.js";

describe("OpenCode provider proxy restoration", () => {
  it("reuses an exact capability and refuses an occupied port", async () => {
    const original = await startOpenCodeProviderProxy("http://127.0.0.1:1/v1", "upstream-fixture", "fixture", {});
    const { port } = new URL(original.baseURL), token = original.token;
    await original.close();
    const foreign = createServer();
    await new Promise<void>((resolve, reject) => { foreign.once("error", reject); foreign.listen(Number(port), "127.0.0.1", resolve); });
    try { await expect(startOpenCodeProviderProxy("http://127.0.0.1:1/v1", "upstream-fixture", "fixture", {}, { port: Number(port), token })).rejects.toMatchObject({ code: "EADDRINUSE" }); }
    finally { await new Promise<void>(resolve => foreign.close(() => resolve())); }
    const restored = await startOpenCodeProviderProxy("http://127.0.0.1:1/v1", "upstream-fixture", "fixture", {}, { port: Number(port), token });
    try {
      expect(restored.baseURL).toBe(original.baseURL); expect(restored.token).toBe(token);
      const response = await fetch(`${restored.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture" }) });
      expect(response.status).toBe(503);
    }
    finally { await restored.close(); }
  });
  it("rejects malformed restoration identity", async () => {
    await expect(startOpenCodeProviderProxy("http://127.0.0.1:1/v1", "fixture", "fixture", {}, { port: 0, token: "bad" })).rejects.toThrow("restoration");
  });
});
