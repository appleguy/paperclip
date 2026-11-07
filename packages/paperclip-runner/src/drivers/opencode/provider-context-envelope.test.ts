import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { startOpenCodeProviderProxy } from "./opencode-server-driver.ts";

// Qualification of native HTTP bytes, not a claim about a live inference model,
// tokenization, Core admission, or ZERO fact/attachment materialization. This
// fixture never inherits provider credentials, real HOME, or an inference URL.
// Opt in with PAPERCLIP_OPENCODE_QUALIFY=1, matching the installed-CLI
// qualification gate in scripts/qualify-opencode-runtime.test.mjs.
// The global AGENTS canary is in the temporary default XDG lookup directory,
// not the real external HOME. Without OPENCODE_CONFIG_DIR both versions admit
// it; the explicit directory used by serve-zero.sh excludes that source.
// v1 still admits its built-in skill prompt and skill/task schemas: preserve
// those strict failures rather than treating its context as ZERO-qualified.
type Version = "v1" | "v2";
type Message = { role: string; content?: unknown; tool_calls?: unknown };
type Tool = { type: string; function: { name: string; parameters: { properties?: Record<string, unknown> } } };
type RequestBody = { model: string; stream: boolean; messages: Message[]; tools: Tool[] };
const TASK = "ENVELOPE_ALLOWED_TASK_6c7c";
const ATTACHMENT = "ENVELOPE_ALLOWED_ATTACHMENT_741a";
const FOLLOWUP = "ENVELOPE_ALLOWED_FOLLOWUP_50bb";
const TOOL_RESULT = "ENVELOPE_ALLOWED_TOOL_RESULT_f823";
const FIRST_FINAL = "ENVELOPE_FIRST_COMPLETE_9d2a";
const SECOND_FINAL = "ENVELOPE_SECOND_COMPLETE_6ec4";
const FORBIDDEN = ["ENVELOPE_FORBIDDEN_HOME_8ab1", "ENVELOPE_FORBIDDEN_PROJECT_4aa2",
  "ENVELOPE_FORBIDDEN_SKILL_7cc3", "ENVELOPE_FORBIDDEN_CONFIG_2dd4"];
const ALLOWED_TOOLS: Record<Version, readonly string[]> = {
  v1: ["bash", "edit", "glob", "grep", "question", "read", "todowrite", "webfetch", "write"],
  v2: ["edit", "glob", "grep", "read", "shell", "write", "execute", "question", "webfetch", "websearch"],
};
const count = (text: string, marker: string) => text.split(marker).length - 1;
const textOf = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const digest = (value: unknown) => createHash("sha256").update(textOf(value)).digest("hex");

async function closeServer(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function stopOwnedChild(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  const deadline = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
  }, 3_000);
  try { await exited; } finally { clearTimeout(deadline); }
}

it.runIf(process.env.PAPERCLIP_OPENCODE_QUALIFY === "1").each<Version>(["v1", "v2"])("captures isolated native OpenCode %s first, tool, and second-turn envelopes", async version => {
  const executable = version === "v1" ? resolve("node_modules/opencode-ai/bin/opencode.exe") : "/opt/homebrew/bin/opencode";
  const root = await mkdtemp(join(tmpdir(), "opencode-context-envelope-"));
  const workspace = join(root, "workspace");
  const nativeHome = join(root, "home");
  const configHome = join(root, "config");
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: nativeHome,
    XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_SHARE: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_SERVER_USERNAME: "paperclip", OPENCODE_SERVER_PASSWORD: "fixture",
    OPENCODE_PASSWORD: "fixture",
  };
  const rawRequests: string[] = [];
  const unexpectedPaths: string[] = [];
  let nativeSessionId: string | undefined;
  let nativeVersion: string | undefined;
  let child: ChildProcess | undefined;
  let engine: Server | undefined;
  let proxy: Awaited<ReturnType<typeof startOpenCodeProviderProxy>> | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(nativeHome, { recursive: true });
    nativeVersion = execFileSync(executable, ["--version"], { encoding: "utf8", cwd: workspace, env, timeout: 10_000 }).trim();
    expect(nativeVersion).toBe(version === "v1" ? "1.18.34" : "opencode v2.2.5");
    const plants: Array<[string, string]> = [
      [join(workspace, "fixture.txt"), `${TOOL_RESULT}\n`],
      [join(nativeHome, ".claude", "CLAUDE.md"), FORBIDDEN[0]!],
      [join(configHome, "opencode", "AGENTS.md"), FORBIDDEN[0]!],
      [join(workspace, "AGENTS.md"), FORBIDDEN[1]!],
      [join(workspace, ".opencode", "skills", "ambient-canary", "SKILL.md"),
        `---\nname: ambient-canary\ndescription: ${FORBIDDEN[2]}\n---\n${FORBIDDEN[2]}\n`],
      [join(nativeHome, ".claude", "skills", "ambient-canary", "SKILL.md"),
        `---\nname: ambient-canary\ndescription: ${FORBIDDEN[2]}\n---\n${FORBIDDEN[2]}\n`],
      [join(workspace, "opencode.json"), JSON.stringify({ instructions: ["ambient-instructions.md"] })],
      [join(workspace, "ambient-instructions.md"), FORBIDDEN[3]!],
    ];
    for (const [path, content] of plants) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }

    engine = createServer(async (request, response) => {
      if (request.url !== "/v1/chat/completions") {
        unexpectedPaths.push(request.url ?? "(missing)");
        response.writeHead(404).end();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        rawRequests.push(raw);
        const data = JSON.parse(raw) as RequestBody;
        const second = data.messages.some(message => message.role === "user" && textOf(message.content).includes(FOLLOWUP));
        const afterTool = data.messages.some(message => message.role === "tool");
        const chunk = (delta: object, finish_reason: string | null) =>
          response.write(`data: ${JSON.stringify({ id: "chatcmpl-envelope-fixture", object: "chat.completion.chunk",
            created: 1, model: "qualification", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (second || afterTool) {
          chunk({ role: "assistant", content: second ? SECOND_FINAL : FIRST_FINAL }, null);
          chunk({}, "stop");
        } else {
          const read = data.tools.find(tool => tool.function.name === "read");
          if (!read) throw new Error("Native request omitted the required read tool");
          const properties = read.function.parameters.properties ?? {};
          const args = Object.hasOwn(properties, "filePath")
            ? { filePath: join(workspace, "fixture.txt") } : { path: join(workspace, "fixture.txt") };
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_envelope_read", type: "function",
            function: { name: "read", arguments: JSON.stringify(args) } }] }, null);
          chunk({}, "tool_calls");
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        response.destroy(error as Error);
      }
    });
    await new Promise<void>(done => engine!.listen(0, "127.0.0.1", done));
    const port = (engine.address() as { port: number }).port;
    proxy = await startOpenCodeProviderProxy(`http://127.0.0.1:${port}/v1`, "", "qualification", {});
    const v1config = {
      model: "openrouter/qualification", small_model: "openrouter/qualification",
      share: "disabled", autoupdate: false, plugin: [], instructions: [],
      enabled_providers: ["openrouter"],
      provider: { openrouter: { options: { baseURL: proxy.baseURL, apiKey: proxy.token },
        models: { qualification: { name: "qualification", limit: { context: 10000, output: 1000 } } } } },
      tools: { task: false, skill: false }, permission: { "*": "allow", task: "deny", skill: "deny" },
    };
    // The negative plugin entries are the already-qualified 2.2.5 ZERO launch
    // policy. Permission deny alone does not remove native skill/tool schemas.
    const v2config = {
      providers: { paperclip: { package: "@opencode/ai/providers/openai-compatible", name: "paperclip",
        settings: { baseURL: proxy.baseURL, apiKey: "{env:PAPERCLIP_PROVIDER_TOKEN}" },
        models: { qualification: { name: "qualification" } } } },
      instructions: [], plugins: ["-opencode.tool.skill", "-opencode.tool.subagent", "-opencode.browser"],
      permission: { skill: "deny", subagent: "deny" },
      agent: { build: { permission: { skill: "deny", subagent: "deny" } } },
      policies: [{ action: "skill.use", resource: "*", effect: "deny" },
        { action: "tool.use", resource: "skill:*", effect: "deny" }], mcp: {},
    };
    const config = join(root, "opencode.json");
    await writeFile(config, JSON.stringify(version === "v1" ? v1config : v2config));
    env.OPENCODE_CONFIG = config;
    env.OPENCODE_CONFIG_DIR = configHome;
    env.PAPERCLIP_PROVIDER_TOKEN = proxy.token;
    if (version === "v2") env.OPENCODE_CONFIG_CONTENT = JSON.stringify(v2config);

    child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const origin = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`OpenCode startup timed out: ${output}`)), 15_000);
      const observe = (chunk: Buffer) => {
        output = (output + chunk).slice(-8_192);
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) { clearTimeout(deadline); resolve(url); }
      };
      child!.stdout!.on("data", observe);
      child!.stderr!.on("data", observe);
      child!.once("error", error => { clearTimeout(deadline); reject(error); });
      child!.once("exit", (code, signal) => { clearTimeout(deadline); reject(new Error(`OpenCode exited ${code}/${signal}: ${output}`)); });
    });
    const headers = { authorization: `Basic ${Buffer.from(`${version === "v1" ? "paperclip" : "opencode"}:fixture`).toString("base64")}`,
      "content-type": "application/json" };
    const api = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response;
    };
    const created = await (await api(version === "v1" ? "/session" : "/api/session", {
      method: "POST", body: JSON.stringify(version === "v1" ? { title: "provider envelope fixture" } :
        { id: "ses_context_envelope", title: "provider envelope fixture",
          model: { providerID: "paperclip", id: "qualification" }, location: { directory: workspace } }),
    })).json();
    const session = version === "v1" ? created : created.data;
    expect(session.id).toMatch(/^ses_/);
    nativeSessionId = session.id;
    const prefix = version === "v1" ? `/session/${session.id}` : `/api/session/${session.id}`;
    const prompt = async (id: string, text: string) => {
      await api(`${prefix}/${version === "v1" ? "prompt_async" : "prompt"}`, {
        method: "POST", body: JSON.stringify(version === "v1"
          ? { providerID: "openrouter", modelID: "qualification", system: "", parts: [{ type: "text", text }] }
          : { id, text }),
      });
    };
    const waitForFinal = async (marker: string) => {
      // Bounded readiness checks for this active fixture only; no background loop.
      for (let attempt = 0; attempt < 150; attempt++) {
        const result = await (await api(`${prefix}/message`)).json();
        const messages = version === "v1" ? result : result.data;
        if (messages.some((message: any) => (message.parts ?? message.content)?.some((part: any) => part.text === marker))) return;
        await delay(100);
      }
      throw new Error(`Native completion missing: ${marker}; captured ${rawRequests.length} requests`);
    };
    const firstText = `Issue: a-provider-capture\n\nDescription: ${TASK}\n\nAttachment:\n${ATTACHMENT}\n\nRead fixture.txt.`;
    const secondText = `Follow-up: ${FOLLOWUP}\nUse the already-read fixture result.`;
    await prompt("msg_envelope_first", firstText);
    await waitForFinal(FIRST_FINAL);
    expect(rawRequests).toHaveLength(2);
    await prompt("msg_envelope_second", secondText);
    await waitForFinal(SECOND_FINAL);
    expect(rawRequests).toHaveLength(3);
    expect(unexpectedPaths).toEqual([]);

    const bodies = rawRequests.map(raw => JSON.parse(raw) as RequestBody);
    for (const [index, body] of bodies.entries()) {
      const raw = rawRequests[index]!;
      expect(body.model).toBe("qualification");
      expect(body.stream).toBe(true);
      for (const marker of [...FORBIDDEN, "<available_skills>", "customize-opencode"]) {
        expect.soft(raw.includes(marker), `request ${index} leaked ${marker}`).toBe(false);
      }
      expect(count(raw, TASK), `task duplicated in request ${index}`).toBe(1);
      expect(count(raw, ATTACHMENT), `attachment duplicated in request ${index}`).toBe(1);
      const names = body.tools.map(tool => tool.function.name);
      expect(names).toContain("read");
      expect(new Set(names).size).toBe(names.length);
      expect.soft([...names].sort(), `unadmitted ${version} tool set in request ${index}`)
        .toEqual([...ALLOWED_TOOLS[version]].sort());
      for (const tool of body.tools) {
        expect(tool.type).toBe("function");
        expect(tool.function.parameters).toBeTypeOf("object");
      }
      const system = body.messages.filter(message => message.role === "system");
      expect(system).toHaveLength(1);
      expect.soft(digest(system), `system changed in request ${index}`).toBe(
        digest(bodies[0]!.messages.filter(message => message.role === "system")));
      expect.soft(digest(body.tools), `tool schemas changed in request ${index}`).toBe(digest(bodies[0]!.tools));
    }
    expect(bodies[0]!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([firstText]);
    expect(bodies[0]!.messages.some(message => message.role === "tool")).toBe(false);
    const continuation = bodies[1]!.messages;
    expect(continuation.at(-1)?.role).toBe("tool");
    expect(textOf(continuation.at(-1)?.content)).toContain(TOOL_RESULT);
    expect(count(rawRequests[1]!, TOOL_RESULT)).toBe(1);
    expect(continuation.some(message => message.role === "assistant" && textOf(message.tool_calls).includes("call_envelope_read"))).toBe(true);
    const second = bodies[2]!.messages;
    expect(second.filter(message => message.role === "user").map(message => message.content)).toEqual([firstText, secondText]);
    expect(second.at(-1)?.role).toBe("user");
    expect(textOf(second.at(-1)?.content)).not.toContain(ATTACHMENT);
    expect(count(rawRequests[2]!, TOOL_RESULT)).toBe(1);
    expect(count(rawRequests[2]!, FIRST_FINAL)).toBe(1);
    expect(count(rawRequests[2]!, FOLLOWUP)).toBe(1);
  } finally {
    await stopOwnedChild(child);
    await proxy?.close();
    await closeServer(engine);
    await rm(root, { recursive: true, force: true });
    // Optional synthetic wire evidence for review; never includes HTTP headers.
    const receipts = process.env.PAPERCLIP_OPENCODE_ENVELOPE_RECEIPT_DIR;
    if (receipts) {
      await mkdir(receipts, { recursive: true });
      for (const [index, raw] of rawRequests.entries()) await writeFile(join(receipts, `${version}-request-${index + 1}.json`), raw);
      const summary = rawRequests.map((raw, index) => {
        const body = JSON.parse(raw) as RequestBody;
        return { request: index + 1, sha256: digest(raw), roles: body.messages.map(message => message.role),
          tools: body.tools.map(tool => tool.function.name),
          forbidden: [...FORBIDDEN, "<available_skills>", "customize-opencode"].filter(marker => raw.includes(marker)),
          occurrences: Object.fromEntries([TASK, ATTACHMENT, FOLLOWUP, TOOL_RESULT, FIRST_FINAL].map(marker => [marker, count(raw, marker)])) };
      });
      await writeFile(join(receipts, `${version}-summary.json`), JSON.stringify({ version, nativeVersion, nativeSessionId, requests: summary, unexpectedPaths,
        provider: "loopback synthetic SSE; no real inference", configDirectory: "explicit temporary OPENCODE_CONFIG_DIR",
        cleanup: { nativeProcessExited: child?.exitCode !== null || child?.signalCode !== null, temporaryRootRemoved: true },
        retention: "Retain until a-provider-capture acceptance archives the evidence, then remove scratch captures." }, null, 2));
    }
  }
}, 60_000);
