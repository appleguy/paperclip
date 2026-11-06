import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { OpenCodeProviderBoundary } from "./provider-boundary.js";
import { startOpenCodeProviderProxy } from "./opencode-server-driver.ts";

it("holds a real qualified OpenCode streaming tool turn through an inference restart", async () => {
  const executable = resolve("node_modules/opencode-ai/bin/opencode.exe");
  expect(execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()).toBe("1.18.34");
  const root = await mkdtemp(join(tmpdir(), "opencode-freeze-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "fixture.txt"), "TOOL_RESULT_MARKER\n");
  const requests: string[] = [];
  let engine: Server | undefined;
  async function startEngine(port = 0) {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push(raw);
      const data = JSON.parse(raw);
      const hasToolResult = data.messages.some((message: { role: string }) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "qualification", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (hasToolResult) {
        chunk({ role: "assistant", content: "FINAL_MARKER" }, null);
        chunk({}, "stop");
      } else {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read_fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: join(workspace, "fixture.txt") }) } }] }, null);
        chunk({}, "tool_calls");
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>(done => server.listen(port, "127.0.0.1", done));
    return server;
  }
  engine = await startEngine();
  const port = (engine.address() as { port: number }).port;
  const boundary = new OpenCodeProviderBoundary();
  const proxy = await startOpenCodeProviderProxy(`http://127.0.0.1:${port}/v1`, "", "qualification", {}, undefined, boundary);
  const config = join(root, "opencode.json");
  await writeFile(config, JSON.stringify({ model: "openrouter/qualification", small_model: "openrouter/qualification", share: "disabled", autoupdate: false, plugin: [], enabled_providers: ["openrouter"], provider: { openrouter: { options: { baseURL: proxy.baseURL, apiKey: proxy.token }, models: { qualification: { name: "qualification", limit: { context: 10000, output: 1000 } } } } }, permission: { "*": "allow" } }));
  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_SERVER_USERNAME: "paperclip", OPENCODE_SERVER_PASSWORD: "fixture" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const exited = once(child, "exit");
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-16_384); });
  try {
    let origin: string | undefined;
    for (let i = 0; i < 150 && !origin; i++) { origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (!origin) await delay(100); }
    expect(origin, output).toBeTruthy();
    const headers = { authorization: `Basic ${Buffer.from("paperclip:fixture").toString("base64")}`, "content-type": "application/json" };
    const api = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response;
    };
    const session = await (await api("/session", { method: "POST", body: JSON.stringify({ title: "freeze fixture" }) })).json() as { id: string };
    const freeze = boundary.freeze({ timeoutMs: 30_000, signal: new AbortController().signal });
    await api(`/session/${session.id}/prompt_async`, { method: "POST", body: JSON.stringify({ providerID: "openrouter", modelID: "qualification", parts: [{ type: "text", text: "Read fixture.txt." }] }) });
    const checkpoint = await freeze;
    const before = requests.length;
    expect(before).toBeGreaterThan(0);
    await new Promise<void>(done => engine!.close(() => done()));
    engine = await startEngine(port);
    boundary.resume(checkpoint);
    let messages: any[] = [];
    for (let i = 0; i < 150; i++) {
      messages = await (await api(`/session/${session.id}/message`)).json() as any[];
      if (messages.some(message => message.parts?.some((part: any) => part.text === "FINAL_MARKER"))) break;
      await delay(100);
    }
    expect(messages.some(message => message.parts?.some((part: any) => part.text === "FINAL_MARKER")), JSON.stringify(messages)).toBe(true);
    const resumed = requests[before]!;
    expect(createHash("sha256").update(resumed).digest("hex")).toBe(checkpoint.requestSha256);
    const resumedBody = JSON.parse(resumed);
    expect(resumedBody.stream).toBe(true);
    expect(resumedBody.messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("TOOL_RESULT_MARKER"))).toBe(true);
  } finally {
    if (child.pid && child.exitCode === null) { try { process.kill(-child.pid, "SIGTERM"); } catch {} await exited; }
    await proxy.close();
    if (engine?.listening) { engine.closeAllConnections(); await new Promise<void>(done => engine!.close(() => done())); }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
