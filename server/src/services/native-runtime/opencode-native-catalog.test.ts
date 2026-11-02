import { describe, expect, it } from "vitest";
import { verifyOpenCodeNativeCatalog } from "./opencode-native-catalog.js";

function fixture(options: { model?: string; variant?: string; provider?: string } = {}) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async url => {
    const path = new URL(String(url)).pathname; calls.push(path);
    const data = path === "/api/provider" ? [] : path.startsWith("/api/provider/") ? { id: options.provider ?? "paperclip", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "http://127.0.0.1:2/v1", apiKey: "fixture" } } : [{ id: options.model ?? "model", providerID: "paperclip", variants: [{ id: options.variant ?? "high" }] }];
    return Response.json({ data });
  };
  return { calls, fetch: fetcher, origin: "http://127.0.0.1:1234", authorization: "test", directory: "/workspace", model: "paperclip/model", effort: "high", providerBaseURL: "http://127.0.0.1:2/v1", providerToken: "fixture" };
}
describe("native effective catalog", () => {
  it("checks the exact provider, model and variant after registry initialization", async () => { const input = fixture(); await verifyOpenCodeNativeCatalog(input); expect(input.calls).toEqual(["/api/provider", "/api/provider/paperclip", "/api/model"]); });
  it("rejects missing model, variant and foreign provider", async () => {
    await expect(verifyOpenCodeNativeCatalog(fixture({ model: "other" }))).rejects.toThrow("model_unavailable");
    await expect(verifyOpenCodeNativeCatalog(fixture({ variant: "low" }))).rejects.toThrow("variant_unavailable");
    await expect(verifyOpenCodeNativeCatalog(fixture({ provider: "other" }))).rejects.toThrow("provider_unavailable");
    await expect(verifyOpenCodeNativeCatalog({ ...fixture(), providerBaseURL: "http://127.0.0.1:3/v1" })).rejects.toThrow("provider_binding_mismatch");
  });
});
