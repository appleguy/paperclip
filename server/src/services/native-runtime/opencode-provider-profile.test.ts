import { expect, it, vi } from "vitest";
import { resolveOpenCodeSharedProvider } from "./opencode-provider-profile.js";

it("admits only an exact discovered model with a configured account", async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ id: "fixture-model" }] }));
  const environment = { PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1234/v1", PAPERCLIP_AI_PROVIDER_KEY: "fixture-secret" };
  expect(await resolveOpenCodeSharedProvider({ model: "paperclip/fixture-model", environment, fetch })).toMatchObject({ provider: "paperclip", model: "fixture-model" });
  await expect(resolveOpenCodeSharedProvider({ model: "paperclip/missing", environment, fetch })).rejects.toThrow("model_unavailable");
  await expect(resolveOpenCodeSharedProvider({ model: "paperclip/fixture-model", environment: { ...environment, PAPERCLIP_AI_PROVIDER_KEY: "" }, fetch })).rejects.toThrow("account_missing");
  await expect(resolveOpenCodeSharedProvider({ model: "foreign/fixture-model", environment, fetch })).rejects.toThrow("profile_unsupported");
  await expect(resolveOpenCodeSharedProvider({ model: "paperclip/fixture-model", environment: { ...environment, PAPERCLIP_AI_PROVIDER_URL: "http://example.com/v1" }, fetch })).rejects.toThrow("endpoint_invalid");
});
