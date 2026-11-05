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
import { OpenCodeHttpDriver, messageIdFor, sessionIdFor } from "./nar/opencode-http-driver.js";
import { narOpIdFor } from "./nar/nar-attempt.js";

const runProcess = vi.mocked(runAdapterExecutionTargetProcess);

// In-memory fake of the OpenCode 2.2.5 session API served on loopback. Executes a prompt synchronously:
// admits the user message, appends one assistant message for it and goes idle with an outcome.
let serverPid = 4242;

describe("OpenCode adapter nativeRuntime nar", () => {
  let root: string;
  let cfg: string;
  let cli: string;
  let server: Server;
  let url = "";
  let sessions: Map<string, { info: any; msgs: any[] }>;
  let active: Set<string>;
  let promptPosts: number;
  let interruptPosts: number;
  let autoComplete: boolean;
  let promptStatus: number | undefined;
  let messagePageSize: number | undefined;
  let clock: number;
  let assistantError: unknown;
  let trailing = false;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-nar-adapter-"));
    cli = path.join(root, "fake-opencode");
    await fs.writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    sessions = new Map();
    active = new Set();
    promptPosts = 0;
    interruptPosts = 0;
    autoComplete = true;
    promptStatus = undefined;
    messagePageSize = undefined;
    clock = 1000;
    assistantError = undefined;
    trailing = false;
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
        if (p === "/api/info") return reply(200, { version: "2.2.5", pid: serverPid, urls: [url + "/"] });
        if (p === "/api/session/active") return reply(200, { data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) });
        if (p === "/api/session" && method === "POST") {
          if (sessions.has(body.id)) return reply(409, {});
          sessions.set(body.id, { info: { id: body.id, title: body.title, location: body.location, model: body.model, time: { created: clock++ } }, msgs: [] });
          return reply(200, { data: sessions.get(body.id)!.info });
        }
        let m = p.match(/^\/api\/session\/([^/]+)$/);
        if (m && method === "PATCH") {
          const s = sessions.get(m[1]!);
          if (!s) return reply(404, {});
          if (typeof body.title === "string") s.info.title = body.title;
          res.writeHead(204); return res.end();
        }
        if (m) { const s = sessions.get(m[1]!); return s ? reply(200, { data: s.info }) : reply(404, {}); }
        m = p.match(/^\/api\/session\/([^/]+)\/prompt$/);
        if (m) {
          promptPosts++;
          const s = sessions.get(m[1]!);
          if (!s) return reply(404, {});
          if (promptStatus) return reply(promptStatus, {});
          if (!s.msgs.some((x) => x.id === body.id)) {
            s.msgs.push({ id: body.id, type: "user", text: body.text, time: { created: clock++ } });
            if (autoComplete) {
              const n = s.msgs.length;
              s.msgs.push({ id: `msg_a${n}`, type: "assistant", time: { created: clock++, completed: clock++ },
                content: [{ type: "text", text: `answer ${n}` }, { type: "tool", name: "read" }],
                cost: 0.5, tokens: { input: 100 * n, output: 10 * n, reasoning: 1, cache: { read: 7, write: 2 } },
                ...(assistantError ? { error: assistantError } : {}) });
              if (trailing) {
                s.msgs.push({ id: `msg_r${n}`, type: "assistant", time: { created: clock++, completed: clock++ },
                  content: [{ type: "text", text: "receipt" }] });
              }
              s.info.time.idle = clock++;
              s.info.outcome = assistantError ? "failed" : "succeeded";
            } else {
              active.add(m[1]!);
            }
          }
          return reply(200, { data: { id: body.id, type: "user" } });
        }
        m = p.match(/^\/api\/session\/([^/]+)\/interrupt$/);
        if (m && method === "POST") {
          interruptPosts++;
          const s = sessions.get(m[1]!);
          if (!s) return reply(404, {});
          const interrupted = active.delete(m[1]!);
          if (interrupted) { s.info.time.idle = clock++; s.info.outcome = "interrupted"; }
          return reply(200, { interrupted });
        }
        m = p.match(/^\/api\/session\/([^/]+)\/inbox$/);
        if (m) return reply(200, { data: [] });
        m = p.match(/^\/api\/session\/([^/]+)\/message$/);
        if (m) {
          const all = sessions.get(m[1]!)?.msgs ?? [];
          if (!messagePageSize) return reply(200, { data: all });
          // Like the real API once paging matters: newest first, `cursor.next` addresses the older page.
          const q = new URL(req.url ?? "", url).searchParams;
          const end = q.has("cursor") ? Number(q.get("cursor")) : all.length;
          const start = Math.max(0, end - Math.min(messagePageSize, Number(q.get("limit") ?? messagePageSize)));
          return reply(200, { data: all.slice(start, end).reverse(), cursor: { previous: null, next: start > 0 ? String(start) : null } });
        }
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

  const context = (runId: string, extra: Record<string, unknown> = {}, taskId = "issue-one", sessionId: string | null = null) => ({
    runId,
    agent: { id: "agent-one", companyId: "company-one", name: "OpenCode Fixture", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId, sessionParams: sessionId ? { sessionId, cwd: root } : null, sessionDisplayId: null, taskKey: taskId },
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

  it("refuses an oversized new NAR prompt before submitting it", async () => {
    const result = await execute(context("run-guard", {
      nativeRuntime: "nar", model: "openai/qwen", tokenPreflightShare: 0.000001,
    }) as never);
    expect(result.exitCode).toBe(75);
    expect(result.errorMessage).toMatch(/Token preflight refused.*qwen.*102400/);
    expect(result.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: false } });
    expect(promptPosts).toBe(0);
  });

  it("records a llama-swap 429 concurrency_limit as a capacity refusal, not an adapter failure", async () => {
    assistantError = { name: "provider.rate-limit", data: { statusCode: 429, code: "concurrency_limit", retryAfterMs: 1000 } };
    const result = await execute(context("run-429", { nativeRuntime: "nar" }) as never);
    expect(result.exitCode).toBe(1);
    expect(result.resultJson).toMatchObject({ adapterPreInferenceAdmission: { kind: "opencode_capacity_refusal_v1", providerWorkStarted: false } });
  });

  it("still sees a 429 when a later non-error assistant message follows the failed one", async () => {
    assistantError = { name: "provider.rate-limit", data: { statusCode: 429, code: "concurrency_limit", retryAfterMs: 1000 } };
    trailing = true;
    const result = await execute(context("run-429t", { nativeRuntime: "nar" }) as never);
    expect(result.exitCode).toBe(1);
    expect(result.resultJson).toMatchObject({ adapterPreInferenceAdmission: { kind: "opencode_capacity_refusal_v1", providerWorkStarted: false } });
  });

  it("a non-capacity failed session is not a capacity refusal", async () => {
    assistantError = { name: "provider.auth", data: { statusCode: 401 } };
    const result = await execute(context("run-401", { nativeRuntime: "nar" }) as never);
    expect(result.exitCode).toBe(1);
    expect(result.resultJson).not.toHaveProperty("adapterPreInferenceAdmission");
  });

  it("names the session after the wake issue and retitles an older placeholder on the next run", async () => {
    const withIssue = (runId: string) => {
      const c = context(runId, { nativeRuntime: "nar" });
      return { ...c, context: { ...c.context, paperclipWake: { issue: { id: "issue-one", identifier: "SCO-12", title: "Fix  the thing" } } } };
    };
    await execute(context("run-1", { nativeRuntime: "nar" }) as never); // no wake issue: placeholder
    expect([...sessions.values()][0]!.info.title).toBe("Paperclip issue-one");
    const first = [...sessions.keys()][0]!;
    const w2 = withIssue("run-2");
    await execute({ ...w2, runtime: { ...w2.runtime, sessionId: first, sessionParams: { sessionId: first, cwd: root } } } as never);
    expect(sessions.size).toBe(1);
    expect([...sessions.values()][0]!.info.title).toBe("SCO-12 Fix the thing");
  });

  it("a restart of the same run does not create a second message; a new run resumes the same session", async () => {
    await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    const again = await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    expect(again).toMatchObject({ exitCode: 0, summary: "answer 1" });
    expect(userMsgs()).toHaveLength(1);
    expect(promptPosts).toBe(2); // re-submitted with the same id, deduped by the server
    const next = await execute(context("run-2", { nativeRuntime: "nar" }, "issue-one", sessionIdFor(scope)) as never);
    expect(sessions.size).toBe(1);
    expect(userMsgs()).toHaveLength(2);
    // Only this op's assistant message is counted, not the earlier run's.
    expect(next).toMatchObject({ exitCode: 0, summary: "answer 3", costUsd: 0.5, usage: { inputTokens: 302 } });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("a wake that arrives without a resumable session after one existed rotates to a fresh generation", async () => {
    await execute(context("run-1", { nativeRuntime: "nar" }) as never);
    const rotated = await execute(context("run-2", { nativeRuntime: "nar" }) as never); // Paperclip cleared the session id
    expect(sessions.size).toBe(2);
    expect(rotated).toMatchObject({ exitCode: 0, sessionId: sessionIdFor(scope, 1) });
    const resumed = await execute(context("run-3", { nativeRuntime: "nar" }, "issue-one", sessionIdFor(scope, 1)) as never);
    expect(sessions.size).toBe(2);
    expect(resumed).toMatchObject({ sessionId: sessionIdFor(scope, 1) });
  });

  it("a retry run after a mid-run Paperclip restart rejoins the in-flight message instead of re-prompting", async () => {
    // Interrupted run-1 left its prompt running in the per-issue session (provider not interrupted).
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("run-1"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, model: { providerID: "openai", id: "qwen", variant: "medium" }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", text: "Full assignment", time: { created: clock++ } }] });
    active.add(sid);
    const finish = setTimeout(() => {
      const s = sessions.get(sid)!;
      s.msgs.push({ id: "msg_done", type: "assistant", time: { created: clock++, completed: clock++ },
        content: [{ type: "text", text: "orphan finished" }], cost: 0.25, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.info.time.idle = clock++;
      s.info.outcome = "succeeded";
      active.delete(sid);
    }, 60);
    const retry = await execute(context("run-1-retry", { nativeRuntime: "nar", model: "openai/qwen", tokenPreflightShare: 0.000001 }) as never); // one 5s poll
    clearTimeout(finish);
    expect(promptPosts).toBe(0);
    expect(userMsgs().map((m) => m.id)).toEqual([orphan]);
    expect(retry).toMatchObject({ exitCode: 0, summary: "orphan finished", sessionId: sid, costUsd: 0.25 });
  }, 15_000);

  it("rejoins a long in-flight turn whose user prompt is older than one page of messages", async () => {
    // A turn that has run for hours: hundreds of assistant messages sit after the single user prompt, so the
    // newest page holds no user message. A retry run used to fail with "active session has no user message".
    messagePageSize = 2;
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("run-1"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, model: { providerID: "openai", id: "fixture", variant: "medium" }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", text: "Full assignment", time: { created: clock++ } },
        ...Array.from({ length: 5 }, (_, i) => ({ id: `msg_work${i}`, type: "assistant", time: { created: clock++ }, content: [{ type: "tool", name: "read" }] }))] });
    active.add(sid);
    const finish = setTimeout(() => {
      const s = sessions.get(sid)!;
      s.msgs.push({ id: "msg_done", type: "assistant", time: { created: clock++, completed: clock++ },
        content: [{ type: "text", text: "long turn finished" }], cost: 0.25, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.info.time.idle = clock++;
      s.info.outcome = "succeeded";
      active.delete(sid);
    }, 60);
    const retry = await execute(context("run-1-retry", { nativeRuntime: "nar" }) as never);
    clearTimeout(finish);
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
    expect(userMsgs().map((m) => m.id)).toEqual([orphan]);
    expect(retry).toMatchObject({ exitCode: 0, sessionId: sid });
  }, 15_000);

  it("registers the heartbeat cancellation barrier and interrupts the exact in-flight NAR turn on explicit pause", async () => {
    autoComplete = false;
    const controller = new AbortController();
    const onCancellationReady = vi.fn(async () => {});
    const run = execute({ ...context("run-pause", { nativeRuntime: "nar" }),
      signal: controller.signal, onCancellationReady } as never);
    const sid = sessionIdFor(scope);
    await vi.waitFor(() => expect(active.has(sid)).toBe(true));
    expect(onCancellationReady).toHaveBeenCalledOnce();
    controller.abort(Object.assign(new Error("Cancelled due to agent pause"), { code: "paperclip_explicit_run_stop" }));
    const stopped = await run;
    // SCO-679: the stop is verified from OpenCode (turn no longer in flight), so cancellation is acknowledged.
    expect(stopped).toMatchObject({ exitCode: 75, errorCode: "cancelled", resultJson: {
      executionCancellation: { state: "acknowledged", proof: "session_idle" },
      executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true } } });
    expect(promptPosts).toBe(1);
    expect(interruptPosts).toBe(1);
    expect(active.size).toBe(0);
    expect(userMsgs()).toHaveLength(1);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("ends the run as verified-interrupted when the OpenCode server restarts mid-run (SCO-679)", async () => {
    autoComplete = false;
    const run = execute({ ...context("run-restart", { nativeRuntime: "nar" }, "issue-one"), signal: new AbortController().signal } as never);
    await vi.waitFor(() => expect(active.size).toBe(1));
    serverPid = 9999; // launchd restarted the server
    try {
      const out = await run;
      expect(out.errorCode).toBe("cancelled");
      expect(out.resultJson).toMatchObject({
        executionCancellation: { state: "acknowledged", proof: "server_restarted" },
        executionRecovery: { kind: "interrupted", sessionPreserved: true } });
    } finally { serverPid = 4242; }
  }, 30_000);

  it("ends the run as verified-interrupted when the session goes idle without settling (SCO-679)", async () => {
    autoComplete = false;
    const run = execute({ ...context("run-idle-dead", { nativeRuntime: "nar" }, "issue-one"), signal: new AbortController().signal } as never);
    await vi.waitFor(() => expect(active.size).toBe(1));
    active.clear(); // e.g. compaction.interrupted: idle, no outcome recorded
    const out = await run;
    expect(out.resultJson).toMatchObject({ executionCancellation: { state: "acknowledged", proof: "session_idle" } });
  }, 120_000);

  it("preserves an in-flight provider turn on untagged shutdown for no-replay rejoin", async () => {
    autoComplete = false;
    const controller = new AbortController();
    const run = execute({ ...context("run-shutdown", { nativeRuntime: "nar" }), signal: controller.signal } as never);
    const sid = sessionIdFor(scope);
    await vi.waitFor(() => expect(active.has(sid)).toBe(true));
    controller.abort(new Error("Server shutting down"));
    const stopped = await run;
    expect(stopped.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true } });
    expect(stopped.errorMessage).toMatch(/preserved for restart rejoin/);
    expect(interruptPosts).toBe(0);
    expect(active.has(sid)).toBe(true);
    expect(promptPosts).toBe(1);
  });

  it("does not send an interrupt to an already-idle session or a different message", async () => {
    await execute(context("run-idle", { nativeRuntime: "nar" }) as never);
    const driver = new OpenCodeHttpDriver({ url, passwordFile: path.join(root, "pw") });
    const sid = sessionIdFor(scope);
    const fence = { runId: "run-idle", leaseGeneration: 1, hostEpoch: 4242 };
    const op = { opId: "stop-run-idle", kind: "interrupt" as const, payloadSha256: "" };
    expect(await driver.interruptExpectedMessage(sid, messageIdFor(narOpIdFor("run-idle")), op, fence)).toBe("idle");
    expect(interruptPosts).toBe(0);
    autoComplete = false;
    const live = execute(context("run-other", { nativeRuntime: "nar" }, "issue-one", sid) as never);
    await vi.waitFor(() => expect(active.has(sid)).toBe(true));
    expect(await driver.interruptExpectedMessage(sid, messageIdFor(narOpIdFor("run-idle")), op, fence)).toBe("idle");
    expect(interruptPosts).toBe(0);
    // Complete the synthetic active turn so the fixture finishes without a long timer.
    const s = sessions.get(sid)!;
    const n = s.msgs.length;
    s.msgs.push({ id: "msg_other_done", type: "assistant", time: { created: clock++, completed: clock++ },
      content: [{ type: "text", text: "done" }], cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
    s.info.time.idle = clock++;
    s.info.outcome = "succeeded";
    active.delete(sid);
    await live;
    expect(n).toBeGreaterThan(0);
  }, 15_000);

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
