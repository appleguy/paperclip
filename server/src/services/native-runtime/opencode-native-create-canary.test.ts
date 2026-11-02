import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { verifyOpenCodeNativeCatalog } from "./opencode-native-catalog.js";
import { startOpenCodeMcpBridge } from "../../vendor/paperclip-runner/index.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.PAPERCLIP_OPENCODE_CREATE_CANARY !== "1")("qualifies native v2 exact empty-session creation without inference", async () => {
  const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-create-canary-");
  for (const name of ["home", "config", "data", "cache", "state", "work"]) await mkdir(join(root, name));
  const password = randomBytes(32).toString("hex"), cwd = join(root, "work");
  const config = { providers: { paperclip: { package: "@opencode/ai/providers/openai-compatible", name: "paperclip", settings: { baseURL: "http://127.0.0.1:1/v1", apiKey: "{env:PAPERCLIP_PROVIDER_TOKEN}" }, models: { "fixture-model": { name: "fixture-model" } } } } };
  const child = spawn("/opt/homebrew/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), PAPERCLIP_PROVIDER_TOKEN: "fixture-token" } });
  child.stderr.resume();
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("native_start_timeout")), 10_000);
      child.once("error", reject); child.once("exit", () => reject(new Error("native_start_failed")));
      child.stdout.on("data", chunk => { buffer += chunk.toString(); const match = buffer.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]!); child.stdout.resume(); } });
    });
    const id = `ses_${randomUUID()}`, model = { providerID: "paperclip", id: "fixture-model", variant: "high" };
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" };
    const origin = `http://127.0.0.1:${port}`;
    const catalogBinding = { fetch, origin, authorization: headers.authorization, directory: cwd, model: "paperclip/fixture-model", effort: "high", providerBaseURL: "http://127.0.0.1:1/v1", providerToken: "fixture-token" };
    await verifyOpenCodeNativeCatalog(catalogBinding);
    await expect(verifyOpenCodeNativeCatalog({ ...catalogBinding, effort: "missing" })).rejects.toThrow("variant_unavailable");
    await expect(verifyOpenCodeNativeCatalog({ ...catalogBinding, providerToken: "foreign" })).rejects.toThrow("provider_binding_mismatch");
    const list = await fetch(`${origin}/api/provider?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(list.status).toBe(200);
    const provider = await fetch(`${origin}/api/provider/paperclip?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(provider.status).toBe(200);
    const discovered = await provider.json() as { data?: { id?: string; package?: string; settings?: { baseURL?: string; apiKey?: string } } };
    expect(discovered.data?.id).toBe("paperclip");
    expect(discovered.data?.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(discovered.data?.settings?.baseURL).toBe("http://127.0.0.1:1/v1");
    expect(discovered.data?.settings?.apiKey).toBe("fixture-token");
    const models = await fetch(`${origin}/api/model?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(models.status).toBe(200);
    const catalog = await models.json() as { data?: Array<{ id?: string; providerID?: string; variants?: Array<{ id?: string }> }> };
    const matching = catalog.data?.filter(item => item.id === "fixture-model" && item.providerID === "paperclip") ?? [];
    expect(matching).toHaveLength(1);
    expect(matching[0]?.variants?.some(variant => variant.id === "high")).toBe(true);
    const created = await fetch(`${origin}/api/session`, { method: "POST", headers, body: JSON.stringify({ id, model, location: { directory: cwd } }), signal: AbortSignal.timeout(10_000) });
    expect(created.status).toBe(200);
    const read = await fetch(`${origin}/api/session/${id}`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { id, model, location: { directory: cwd } } });
    const bridge = await startOpenCodeMcpBridge({ tools: [{ name: "fixture_tool", inputSchema: { type: "object" } }], admitSharedCall: async () => { throw new Error("not admitted"); }, handler: async () => { throw new Error("not admitted"); } });
    try {
      const config = { type: "remote", url: bridge.url, headers: { Authorization: `Bearer ${bridge.secret}` }, oauth: false, codemode: false };
      const replacement = await fetch(`${origin}/api/experimental/mcp/paperclip?directory=${encodeURIComponent(cwd)}`, { method: "PUT", headers, body: JSON.stringify({ config }), signal: AbortSignal.timeout(10_000) });
      expect(replacement.status).toBe(204);
      const listed = await fetch(`${origin}/api/mcp?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(10_000) });
      expect(listed.status).toBe(200);
      const body = await listed.json() as { data?: Array<{ name?: string; status?: { status?: string } }> };
      expect(body.data?.some(item => item.name === "paperclip" && item.status?.status === "connected")).toBe(true);
    } finally { await bridge.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native_shutdown_unconfirmed")), 5000))]);
  }
}, 30_000);
