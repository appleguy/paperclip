import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { OpenCodeHttpDriver } from "./opencode-http-driver.ts";

const host = { provider: "opencode" as const, hostEpoch: 1, attested: true };
const fence = { runId: "run-test", leaseGeneration: 1, hostEpoch: 1 };
const scope = { agentId: "qwen", issueId: "test", cwd: "/tmp", model: "native-fleet/qwen" };
function driver(variant: string | undefined, model = "qwen", providerID = "native-fleet") {
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ data: {} });
    return Response.json({ data: { id: "ses_test", location: { directory: "/tmp" }, model: { providerID, id: model, variant } } });
  };
  return new OpenCodeHttpDriver({ url: "http://localhost:4096", passwordFile: fileURLToPath(import.meta.url), fetchImpl: fetchImpl as typeof fetch });
}
describe("OpenCode session model verification", () => {
  it.each([undefined, "default"])("accepts server default variant %s", async variant => {
    await expect(driver(variant).bindConversation(host, scope, "new", fence, "ses_test")).resolves.toMatchObject({ conversationId: "ses_test" });
  });
  it("accepts the same named variant and rejects a different one", async () => {
    const named = { ...scope, model: "native-fleet/qwen#high" };
    await expect(driver("high").bindConversation(host, named, "resume", fence, "ses_test")).resolves.toBeDefined();
    await expect(driver("default").bindConversation(host, named, "resume", fence, "ses_test")).rejects.toThrow("session model");
    await expect(driver("high").bindConversation(host, scope, "resume", fence, "ses_test")).rejects.toThrow("session model");
  });
  it("rejects different model and provider", async () => {
    await expect(driver("default", "other").bindConversation(host, scope, "resume", fence, "ses_test")).rejects.toThrow("session model");
    await expect(driver("default", "qwen", "other").bindConversation(host, scope, "resume", fence, "ses_test")).rejects.toThrow("session model");
  });
});
