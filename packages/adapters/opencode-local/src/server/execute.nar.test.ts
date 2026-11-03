import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: vi.fn(),
}));
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";
import { messageIdFor, sessionIdFor } from "./nar/opencode-http-driver.js";
import { narOpIdFor } from "./nar/nar-attempt.js";

const runProcess = vi.mocked(runAdapterExecutionTargetProcess);

// In-memory fake of the OpenCode 2.2.5 session API served on loopback. Executes a prompt synchronously:
// admits the user message, appends one assistant message for it and goes idle with an outcome.
describe("OpenCode adapter nativeRuntime nar", () => {
  let root: string;
  let cfg: string;
  let cli: string;
  let server: Server;
  let url = "";
  let sessions: Map<string, { info: any; msgs: any[] }>;
  let promptPosts: number;
  let promptStatus: number | undefined;
  let clock: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-nar-adapter-"));
    cli = path.join(root, "fake-opencode");
    await fs.writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    sessions = new Map();
    promptPosts = 0;
    promptStatus = undefined;
    clock = 1000;
    vi.stubEnv("XDG_CONFIG_HOME", root);
    runProcess.mockReset();
    const expected = "Basic " + Buffer.from("opencode:local-secret").toString("base64");
    server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        if (req.headers.authorization !== expected) return reply(401, {});
        const body = raw ? JSON.parse(raw) : undefined;
        const p = (req.url ?? "").split("?")[0]!;
        const method = req.method;
        if (p === "/api/info") return reply(200, { version: "2.2.5", pid: 4242, urls: [url + "/"] });
        if (p === "/api/session/active") return reply(200, { data: {} });
        if (p === "/api/session" && method === "POST") {
          if (sessions.has(body.id)) return reply(409, {});
          sessions.set(body.id, { info: { id: body.id, location: body.location, model: body.model, time: { created: clock++ } }, msgs: [] });
          return reply(200, { data: sessions.get(body.id)!.info });
        }
        let m = p.match(/^\/api\/session\/([^/]+)$/);
        if (m) { const s = sessions.get(m[1]!); return s ? reply(200, { data: s.info }) : reply(404, {}); }
        m = p.match(/^\/api\/session\/([^/]+)\/prompt$/);
        if (m) {
          promptPosts++;
          const s = sessions.get(m[1]!);
          if (!s) return reply(404, {});
          if (promptStatus) return reply(promptStatus, {});
          if (!s.msgs.some((x) => x.id === body.id)) {
            s.msgs.push({ id: body.id, type: "user", text: body.text, time: { created: clock++ } });
            const n = s.msgs.length;
            s.msgs.push({ id: `msg_a${n}`, type: "assistant", time: { created: clock++, completed: clock++ },
              content: [{ type: "text", text: `answer ${n}` }, { type: "tool", name: "read" }],
              cost: 0.5, tokens: { input: 100 * n, output: 10 * n, reasoning: 1, cache: { read: 7, write: 2 } } });
            s.info.time.idle = clock++;
            s.info.outcome = "succeeded";
          }
          return reply(200, { data: { id: body.id, type: "user" } });
        }
        m = p.match(/^\/api\/session\/([^/]+)\/inbox$/);
        if (m) return reply(200, { data: [] });
        m = p.match(/^\/api\/session\/([^/]+)\/message$/);
        if (m) return reply(200, { data: sessions.get(m[1]!)?.msgs ?? [] });
        m = p.match(/^\/api\/session\/([^/]+)\/message\/([^/]+)$/);
        if (m) { const x = sessions.get(m[1]!)?.msgs.find((y) => y.id === m![2]); return x ? reply(200, { data: x }) : reply(404, {}); }
        m = p.match(/^\/api\/experimental\/session\/([^/]+)\/log$/);
        if (m) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          return res.end(`data: ${JSON.stringify({ type: "log.synced", aggregateID: m[1], seq: 0 })}\n\n`);
        }
        return reply(404, {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const passwordFile = path.join(root, "pw");
    await fs.writeFile(passwordFile, "local-secret", { mode: 0o600 });
    cfg = path.join(root, "shared.json");
    await fs.writeFile(cfg, JSON.stringify({ url, passwordFile }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await fs.rm(root, { force: true, recursive: true });
  });

  const context = (runId: string, extra: Record<string, unknown> = {}, taskId = "issue-one") => ({
    runId,
    agent: { id: "agent-one", companyId: "company-one", name: "OpenCode Fixture", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: taskId },
    config: { command: cli, cwd: root, model: "openai/fixture", variant: "medium", sharedServerRecoveryConfigPath: cfg,
      promptTemplate: "Full assignment", env: { OPENCODE_ALLOW_ALL_MODELS: "1" }, ...extra },
    context: { taskId, paperclipTaskMarkdown: "Finish SCO-337" },
    onLog: async () => {},
  });
  const userMsgs = () => [...sessions.values()].flatMap((s) => s.msgs.filter((m) => m.type === "user"));
  const scope = { agentId: "agent-one", issueId: "issue-one" };

  it("settles through the HTTP driver without spawning a process", async () => {
    const result = await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    expect(runProcess).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exitCode: 0, timedOut: false, errorMessage: null, sessionId: sessionIdFor(scope), summary: "answer 1",
      usage: { inputTokens: 102, outputTokens: 11, cachedInputTokens: 7 }, costUsd: 0.5,
    });
    expect(sessions.size).toBe(1);
    expect(userMsgs().map((m) => m.id)).toEqual([messageIdFor(narOpIdFor("run-1"))]);
    expect([...sessions.values()][0]!.info.model).toEqual({ providerID: "openai", id: "fixture", variant: "medium" });
  });

  it("a restart of the same run does not create a second message; a new run resumes the same session", async () => {
    await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    const again = await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    expect(again).toMatchObject({ exitCode: 0, summary: "answer 1" });
    expect(userMsgs()).toHaveLength(1);
    expect(promptPosts).toBe(2); // re-submitted with the same id, deduped by the server
    const next = await execute(context("run-2", { nativeRuntime: "nar" }) as never);
    expect(sessions.size).toBe(1);
    expect(userMsgs()).toHaveLength(2);
    // Only this op's assistant message is counted, not the earlier run's.
    expect(next).toMatchObject({ exitCode: 0, summary: "answer 3", costUsd: 0.5, usage: { inputTokens: 302 } });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("holds on an unknown submit outcome and never resends", async () => {
    promptStatus = 503;
    const result = await execute(context("run-3", { nativeRuntime: "nar" }) as never);
    expect(promptPosts).toBe(1);
    expect(result.exitCode).toBe(75);
    expect(result.errorMessage).toMatch(/outcome unknown/);
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: true } });
    expect(userMsgs()).toHaveLength(0);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("a pre-submit failure reports providerWorkStarted false", async () => {
    await fs.writeFile(cfg, JSON.stringify({ url, passwordFile: path.join(root, "pw-missing") }));
    const result = await execute(context("run-4", { nativeRuntime: "nar" }) as never);
    expect(result.exitCode).toBe(75);
    expect(result.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(promptPosts).toBe(0);
  });

  it("legacy default is untouched: the flag is ignored without a shared config and absent/legacy spawn the process", async () => {
    runProcess.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "text", sessionID: "ses_legacy1234", part: { text: "legacy" } }), stderr: "", pid: 1, startedAt: "" } as never);
    for (const extra of [{ sharedServerRecoveryConfigPath: "", nativeRuntime: "nar" }, { sharedServerRecoveryConfigPath: "" }, { sharedServerRecoveryConfigPath: "", nativeRuntime: "legacy" }]) {
      const r = await execute(context("legacy", extra) as never);
      expect(r).toMatchObject({ exitCode: 0, summary: "legacy", sessionId: "ses_legacy1234" });
    }
    expect(runProcess).toHaveBeenCalledTimes(3);
    expect(promptPosts).toBe(0);
    expect(sessions.size).toBe(0);
  });
});
