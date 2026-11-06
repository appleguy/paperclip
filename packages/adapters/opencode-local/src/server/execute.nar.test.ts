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
import { sessionCodec } from "./index.js";
import { OpenCodeHttpDriver, messageIdFor, sessionIdFor } from "./nar/opencode-http-driver.js";
import { narOpIdFor, runNarOpenCodeAttempt } from "./nar/nar-attempt.js";
import { estimatePromptTokens } from "@paperclipai/adapter-utils/token-preflight";

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
  let successorOnMessageRead: number;
  let messageReadsAfterPrompt: number;

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
    successorOnMessageRead = Infinity;
    messageReadsAfterPrompt = 0;
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
          if (promptPosts && ++messageReadsAfterPrompt === successorOnMessageRead) {
            all.push({ id: "msg_external_successor", type: "user", text: "other run", time: { created: clock++ } },
              { id: "msg_external_result", type: "assistant", time: { created: clock++, completed: clock++ },
                content: [{ type: "text", text: "other result" }], cost: 10 });
          }
          if (!messagePageSize) return reply(200, { data: [...all].reverse() });
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

  it("does not attribute an older turn with the same timestamp to the live outcome", async () => {
    const sid = sessionIdFor(scope);
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: 998 } }, msgs: [
      { id: "old_user", type: "user", time: { created: 999 } },
      { id: "old_answer", type: "assistant", time: { created: clock }, content: [{ type: "text", text: "old answer" }],
        cost: 9, tokens: { input: 900, output: 900, cache: { read: 0, write: 0 } } },
    ] });
    const result = await execute(context("run-tied-outcome", { nativeRuntime: "nar" }, "issue-one", sid) as never);
    expect(result).toMatchObject({ exitCode: 0, summary: "answer 3", costUsd: 0.5,
      usage: { inputTokens: 302, outputTokens: 31, cachedInputTokens: 7 } });
    expect(promptPosts).toBe(1);
  });

  it("checkpoints the exact run and message before submitting a NAR prompt", async () => {
    const saved: unknown[] = [];
    const result = await execute({ ...context("run-bound", { nativeRuntime: "nar" }),
      onSession: async (session: unknown) => { expect(promptPosts).toBe(0); saved.push(session); },
    } as never);
    expect(result.exitCode).toBe(0);
    expect(saved).toMatchObject([{ sessionId: sessionIdFor(scope), sessionParams: { sessionId: sessionIdFor(scope),
      narBinding: { schema: "paperclip.opencode-binding.v1", runId: "run-bound", agentId: scope.agentId,
        taskId: scope.issueId, messageId: messageIdFor(narOpIdFor("run-bound")), kind: "submit", hostPid: serverPid, configPath: cfg, providerOrigin: url } } }]);
    const params = (saved[0] as { sessionParams: Record<string, unknown> }).sessionParams;
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toMatchObject({ narBinding: params.narBinding });
  });

  it("does not submit a new prompt if binding persistence fails", async () => {
    const result = await execute({ ...context("run-unbound", { nativeRuntime: "nar" }),
      onSession: async () => { throw new Error("checkpoint lost ownership"); },
    } as never);
    expect(promptPosts).toBe(0);
    expect(result.resultJson?.executionRecovery).toMatchObject({ providerWorkStarted: false });
  });

  it.each([1, 2])("holds live completion when a successor appears on outcome read %i", async (read) => {
    successorOnMessageRead = read;
    const result = await execute(context("run-live-successor", { nativeRuntime: "nar" }) as never);
    expect(result).toMatchObject({ exitCode: 75, resultJson: { executionRecovery: {
      providerWorkStarted: true, reason: "unowned_successor",
    } } });
    expect(result.summary ?? "").toBe("");
    expect(result.costUsd ?? null).toBeNull();
    expect(promptPosts).toBe(1);
    expect(interruptPosts).toBe(0);
  });

  it("holds live completion if its target is outside the outcome window", async () => {
    messagePageSize = 1;
    const result = await execute(context("run-live-older", { nativeRuntime: "nar" }) as never);
    expect(result).toMatchObject({ exitCode: 75, resultJson: { executionRecovery: {
      providerWorkStarted: true, reason: "outcome_unknown",
    } } });
    expect(promptPosts).toBe(1);
    expect(interruptPosts).toBe(0);
  });

  it("retains possible provider work if checkpointing a rejoined turn fails", async () => {
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("run-old"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", time: { created: clock++ } }] });
    active.add(sid);
    const result = await execute({ ...context("run-rejoin", { nativeRuntime: "nar" }),
      onSession: async () => { throw new Error("checkpoint lost ownership"); },
    } as never);
    expect(result.resultJson?.executionRecovery).toMatchObject({ providerWorkStarted: true });
    expect(active.has(sid)).toBe(true);
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
  });

  it("posts stable instructions before per-run bridge material in the exact NAR body", async () => {
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "Stable launch instructions.", "utf8");
    await execute({
      ...context("run-prefix-wire", {
        nativeRuntime: "nar",
        instructionsFilePath,
        bootstrapPromptTemplate: "Stable bootstrap instructions.",
        promptTemplate: "Stable agent template.",
      }),
      authToken: "test-paperclip-token",
      context: {
        taskId: "issue-prefix",
        paperclipTaskCommunicationGuidance: "Stable communication guidance.",
        paperclipTaskMarkdownAssignment: "Stable assignment context.",
      },
    } as never);

    const prompt = String(userMsgs()[0]!.text);
    const stablePrefix = [
      "Stable launch instructions.",
      "Stable bootstrap instructions.",
      "Stable communication guidance.",
      "Stable agent template.",
    ].join("\n\n");
    expect(prompt.startsWith(stablePrefix)).toBe(true);
    expect(prompt.indexOf("Stable assignment context.")).toBeGreaterThan(
      prompt.indexOf("Stable agent template."),
    );
    const bridgeNoteOffset = prompt.indexOf("Paperclip access: use the paperclip-run MCP tools");
    expect(bridgeNoteOffset).toBeGreaterThan(Buffer.byteLength(stablePrefix, "utf8"));
    expect(prompt.slice(bridgeNoteOffset)).toContain("valid for this run only.");
    expect(prompt).not.toContain("test-paperclip-token");
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

  it("rotates an idle NAR conversation after checking the assembled prompt", async () => {
    const first = await execute(context("run-peak-1", { nativeRuntime: "nar" }) as never);
    const ctx = context("run-peak-2", { nativeRuntime: "nar" }, "issue-one", first.sessionId!);
    const gate = vi.fn(async () => ({ rotate: true, reason: "peak plus prompt exceeds limit", handoffMarkdown: "Unfinished handoff marker" }));
    const rotated = await execute({ ...ctx, evaluateSessionPrompt: gate } as never);
    expect(gate).toHaveBeenCalledOnce();
    expect(rotated).toMatchObject({ exitCode: 0, sessionId: sessionIdFor(scope, 1) });
    expect(sessions.get(sessionIdFor(scope, 1))?.msgs[0]?.text).toContain("Unfinished handoff marker");
    expect(sessions.get(sessionIdFor(scope))?.msgs).toHaveLength(2);
    expect(promptPosts).toBe(2);
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

  it("keeps a saved NAR session and sends only the wake delta with a bounded first-request fixture", async () => {
    const standing = "Standing instructions: preserve completed work.\n".repeat(140).slice(0, 6401);
    const instructionsFilePath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, standing);
    const bootstrap = "Bootstrap this agent once.";
    const makeContext = (runId: string, savedSession: string | null) => ({
      ...context(runId, { nativeRuntime: "nar", instructionsFilePath, bootstrapPromptTemplate: bootstrap }, "issue-one", savedSession),
      context: {
        taskId: "issue-one",
        paperclipTaskMarkdownAssignment: "Finish the owned assignment.",
        paperclipTaskMarkdownAssignmentCompact: "Continue the unfinished assignment.",
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "issue-one", identifier: "SCO-857", title: "Prompt continuity", status: "in_progress" },
          executionContinuation: {
            version: 1, companyId: "company-one", issueId: "issue-one",
            trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
            originCommentIds: [], messages: [], humanResponses: [], unresolvedInteractionIds: [],
            interactionOutcomes: [], completedActions: [], completedWork: null, recoveryOutcomes: [],
            coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
          },
        },
      },
    });
    const first = await execute(makeContext("run-prompt-first", null) as never);
    const metrics: Record<string, unknown>[] = [];
    const next = await execute({ ...makeContext("run-prompt-next", first.sessionId!),
      onMeta: async (meta: Record<string, unknown>) => { metrics.push(meta.promptMetrics as Record<string, unknown>); },
    } as never);
    expect(first.exitCode).toBe(0);
    expect(next).toMatchObject({ exitCode: 0, sessionId: first.sessionId });
    expect(sessions.size).toBe(1);
    const [fresh, resumed] = userMsgs().map((message) => message.text as string);
    expect(fresh).toContain(standing);
    expect(fresh).toContain(bootstrap);
    expect(resumed).toContain("## Paperclip Resume Delta");
    expect(resumed).toContain("Continue the unfinished assignment.");
    expect(resumed).toContain("No prior-run outcomes recorded.");
    expect(resumed).not.toContain("Standing instructions:");
    expect(resumed).not.toContain("The above agent instructions were loaded from");
    expect(resumed).not.toContain(bootstrap);
    expect(resumed).not.toContain("Full assignment");
    expect(metrics[0]?.instructionsChars).toBe(0);
    // Complete credential-free request fixture. The system/tool surface is
    // deliberately fixed here; this does not claim the fleet's live schemas fit.
    const request = {
      model: "openai/fixture",
      system: "You are a coding assistant. Continue the assigned work.",
      tools: [{ name: "read_file", description: "Read a workspace file", parameters: {
        type: "object", properties: { path: { type: "string" } }, required: ["path"],
      } }],
      messages: [{ role: "user", content: fresh }],
    };
    const firstRequestTokenBound = estimatePromptTokens(JSON.stringify(request));
    expect(firstRequestTokenBound).toBeLessThanOrEqual(12_000);
    expect(estimatePromptTokens(resumed!)).toBeLessThan(estimatePromptTokens(fresh!) - 6401);
    console.info("SCO-857 first-request fixture", JSON.stringify({
      method: "one-token-per-UTF8-byte upper bound", firstRequestTokenBound,
      freshPromptBytes: Buffer.byteLength(fresh!), resumedPromptBytes: Buffer.byteLength(resumed!),
    }));
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

  it("holds a foreign in-flight turn after rejoining without attributing its outcome", async () => {
    // Interrupted run-1 left its prompt running in the per-issue session (provider not interrupted).
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("run-1"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, model: { providerID: "openai", id: "qwen", variant: "medium" }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", text: "Full assignment", time: { created: clock++ } }] });
    active.add(sid);
    const finish = () => {
      const s = sessions.get(sid)!;
      s.msgs.push({ id: "msg_done", type: "assistant", time: { created: clock++, completed: clock++ },
        content: [{ type: "text", text: "orphan finished" }], cost: 0.25, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.info.time.idle = clock++;
      s.info.outcome = "succeeded";
      active.delete(sid);
    };
    const gate = vi.fn(async () => { throw new Error("must never rotate an in-flight rejoin"); });
    const saved: unknown[] = [];
    const retry = await execute({ ...context("run-1-retry", { nativeRuntime: "nar", model: "openai/qwen", tokenPreflightShare: 0.000001 }), evaluateSessionPrompt: gate,
      onSession: async (session: unknown) => { saved.push(session); },
      onLog: async (_stream: string, chunk: string) => { if (chunk.includes("nar_rejoin")) finish(); } } as never);
    expect(promptPosts).toBe(0);
    expect(gate).not.toHaveBeenCalled();
    expect(userMsgs().map((m) => m.id)).toEqual([orphan]);
    expect(saved).toMatchObject([{ sessionParams: { narBinding: { runId: "run-1-retry", messageId: orphan, kind: "rejoin" } } }]);
    expect(interruptPosts).toBe(0);
    expect(retry).toMatchObject({ exitCode: 75, summary: "", sessionId: sid, costUsd: null,
      resultJson: { executionRecovery: { providerWorkStarted: true, reason: expect.stringMatching(/^unowned_turn_(verified_idle|settled)$/) } } });
  }, 15_000);

  it.each([true, false])("holds before provider contact when already aborted (reattach: %s)", async (reattachOnly) => {
    const abort = new AbortController();
    abort.abort();
    const result = await runNarOpenCodeAttempt({ configPath: cfg, agentId: scope.agentId, taskId: scope.issueId,
      runId: "already-aborted", cwd: root, model: "", prompt: "original", timeoutSec: 5,
      reattachOnly, signal: abort.signal, onLog: async () => {} });
    expect(result.executionRecovery).toMatchObject({ providerWorkStarted: true, providerWorkEvidence: "unverified",
      reason: "stop_before_dispatch_unverified" });
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
  });

  it.each([true, false])("holds after binding before prompt POST when aborted (explicit Stop: %s)", async (explicit) => {
    const abort = new AbortController();
    const input = { configPath: cfg, agentId: scope.agentId, taskId: scope.issueId, runId: "before-post", cwd: root,
      model: "", prompt: "original", timeoutSec: 5, pollMs: 1, onLog: async () => {} };
    const original = await runNarOpenCodeAttempt({ ...input, signal: abort.signal, onBound: async () => {
      abort.abort(explicit ? Object.assign(new Error("Stop"), { code: "paperclip_explicit_run_stop" }) : new Error("Restart"));
    } });
    expect(original.executionRecovery).toMatchObject({ providerWorkStarted: true, providerWorkEvidence: "unverified",
      reason: "stop_before_dispatch_unverified" });
    expect(promptPosts).toBe(0);

    // The restarted controller cannot rely on another process's local abort.
    const restarted = await runNarOpenCodeAttempt({ ...input, reattachOnly: true });
    expect(restarted.executionRecovery).toMatchObject({ providerWorkStarted: true, providerWorkEvidence: "unverified", reason: "reattach_message_missing" });
    expect(promptPosts).toBe(0);
  });

  it.each([true, false])("holds without POST when cancellation arrives during dispatch logging (explicit Stop: %s)", async (explicit) => {
    const controller = new AbortController();
    let releaseLog!: () => void;
    let reachedLog!: () => void;
    const atLog = new Promise<void>((resolve) => { reachedLog = resolve; });
    const logGate = new Promise<void>((resolve) => { releaseLog = resolve; });
    const attempt = runNarOpenCodeAttempt({ configPath: cfg, agentId: scope.agentId, taskId: scope.issueId,
      runId: "stop-during-log", cwd: root, model: "", prompt: "original", timeoutSec: 5,
      signal: controller.signal, onLog: async (_stream, chunk) => {
        if (chunk.includes("nar_prompt_dispatch")) { reachedLog(); await logGate; }
      } });
    try {
      await atLog;
      controller.abort(explicit ? Object.assign(new Error("Stop"), { code: "paperclip_explicit_run_stop" }) : new Error("Restart"));
    } finally { releaseLog(); }
    const result = await attempt;
    expect(result.executionRecovery).toMatchObject({ providerWorkStarted: true, providerWorkEvidence: "unverified",
      reason: "stop_before_dispatch_unverified" });
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
  });

  it("does not retry an absent message while the old controller is about to POST", async () => {
    let releasePost!: () => void;
    let reachedDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => { reachedDispatch = resolve; });
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const input = { configPath: cfg, agentId: scope.agentId, taskId: scope.issueId, runId: "delayed-post", cwd: root,
      model: "", prompt: "original", timeoutSec: 5, pollMs: 1 };
    const original = runNarOpenCodeAttempt({ ...input, onLog: async (_stream, chunk) => {
      if (chunk.includes("nar_prompt_dispatch")) { reachedDispatch(); await postGate; }
    } });
    try {
      await dispatch;
      const restarted = await runNarOpenCodeAttempt({ ...input, reattachOnly: true, onLog: async () => {} });
      expect(restarted.executionRecovery).toMatchObject({ providerWorkStarted: true, providerWorkEvidence: "unverified", reason: "reattach_message_missing" });
      expect(promptPosts).toBe(0);
    } finally {
      releasePost();
      await original;
    }
    expect(promptPosts).toBe(1);
    expect(userMsgs().map((message) => message.id)).toEqual([messageIdFor(narOpIdFor("delayed-post"))]);
  }, 15_000);

  it("distinguishes an original message found in multiple generations", async () => {
    const message = messageIdFor(narOpIdFor("duplicate-run"));
    for (const generation of [0, 1]) {
      const sid = sessionIdFor(scope, generation);
      sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: clock++ } },
        msgs: [{ id: message, type: "user", time: { created: clock++ } }] });
    }
    const result = await runNarOpenCodeAttempt({ configPath: cfg, agentId: scope.agentId, taskId: scope.issueId,
      runId: "duplicate-run", cwd: root, model: "", prompt: "unused", timeoutSec: 5, reattachOnly: true,
      onLog: async () => {} });
    expect(result.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "reattach_message_ambiguous" });
    expect(promptPosts).toBe(0);
  });

  it("holds a persisted rejoined foreign message without taking Stop ownership", async () => {
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("original-run"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", time: { created: clock++ } }] });
    active.add(sid);
    const params = { sessionId: sid, cwd: root, narBinding: { schema: "paperclip.opencode-binding.v1", runId: "retry-run",
      agentId: scope.agentId, taskId: scope.issueId, messageId: orphan, kind: "rejoin", configPath: cfg, providerOrigin: url } };
    const retry = await execute({ ...context("retry-run", { nativeRuntime: "nar" }),
      context: { taskId: scope.issueId, paperclipRestartReattach: true,
        paperclipRestartReattachSession: { sessionId: sid, sessionParams: params } },
      onLog: async (_stream: string, chunk: string) => {
        if (chunk.includes("nar_rejoin")) {
          const s = sessions.get(sid)!;
          s.msgs.push({ id: "msg_done", type: "assistant", time: { created: clock++, completed: clock++ },
            content: [{ type: "text", text: "done" }] });
          s.info.time.idle = clock++; s.info.outcome = "succeeded"; active.delete(sid);
        }
      },
    } as never);
    expect(retry).toMatchObject({ exitCode: 75, summary: "", resultJson: { executionRecovery: {
      providerWorkStarted: true, reason: expect.stringMatching(/^unowned_turn_(verified_idle|settled)$/) } } });
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
  });

  it("holds a reattach when the persisted binding belongs to another run", async () => {
    const sid = sessionIdFor(scope);
    const result = await execute({ ...context("run-current", { nativeRuntime: "nar" }),
      context: { taskId: scope.issueId, paperclipRestartReattach: true,
        paperclipRestartReattachSession: { sessionId: sid, sessionParams: { sessionId: sid, cwd: root,
          narBinding: { schema: "paperclip.opencode-binding.v1", runId: "run-other", agentId: scope.agentId,
            taskId: scope.issueId, messageId: "msg_old", kind: "rejoin", configPath: cfg, providerOrigin: url } } } },
    } as never);
    expect(result.resultJson?.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "reattach_binding_invalid" });
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
  });

  it("logs new text and tool progress while a rejoined turn is still running", async () => {
    const sid = sessionIdFor(scope);
    const message = messageIdFor(narOpIdFor("run-1"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: clock++ } },
      msgs: [{ id: message, type: "user", time: { created: clock++ } }] });
    active.add(sid);
    const lines: string[] = [];
    let progressWhileActive = false;
    let progress: ReturnType<typeof setTimeout> | undefined;
    let finish: ReturnType<typeof setTimeout> | undefined;
    const attempt = runNarOpenCodeAttempt({ configPath: cfg, ...scope, taskId: scope.issueId, runId: "run-1", cwd: root,
      model: "", prompt: "unused", timeoutSec: 5, pollMs: 10,
      onLog: async (_stream, chunk) => {
        lines.push(chunk);
        if (chunk.includes("nar_rejoin")) {
          progress = setTimeout(() => sessions.get(sid)!.msgs.push({ id: "msg_progress", type: "assistant", time: { created: clock++ },
            content: [{ type: "text", text: "working" }, { type: "tool", name: "read", state: { status: "running" } }] }), 20);
          finish = setTimeout(() => { const s = sessions.get(sid)!; s.info.time.idle = clock++; s.info.outcome = "succeeded"; active.delete(sid); }, 200);
        }
        if (chunk.includes("working") && active.has(sid)) progressWhileActive = true;
      } });
    try {
      const result = await attempt;
      expect(result.proc.exitCode).toBe(0);
      expect(progressWhileActive).toBe(true);
      expect(lines.join("")).toContain("read: running");
      expect(lines.join("").match(/working/g)).toHaveLength(1);
      expect(promptPosts).toBe(0);
    } finally { clearTimeout(progress); clearTimeout(finish); }
  });

  it("does not include a successor's progress when the target spans message pages", async () => {
    messagePageSize = 2;
    const sid = sessionIdFor(scope);
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: clock++ } }, msgs: [
      { id: "target", type: "user", time: { created: clock++ } },
      { id: "own", type: "assistant", time: { created: clock++ }, content: [{ type: "text", text: "own work" }] },
      { id: "successor", type: "user", time: { created: clock++ } },
      { id: "other", type: "assistant", time: { created: clock++ }, content: [{ type: "text", text: "other work" }] },
    ] });
    const driver = new OpenCodeHttpDriver({ url, passwordFile: path.join(root, "pw") });
    expect(await driver.progressMessages(sid, "target")).toEqual([{ id: "own", content: [{ type: "text", text: "own work" }] }]);
  });

  it.each([100, undefined])("uses message order to exclude successor progress with timestamp %s", async (successorTime) => {
    messagePageSize = 2;
    const sid = sessionIdFor(scope);
    sessions.set(sid, { info: { id: sid, location: { directory: root }, time: { created: 1 } }, msgs: [
      { id: "target", type: "user", time: { created: 100 } },
      { id: "own", type: "assistant", time: { created: 100 }, content: [{ type: "text", text: "own work" }] },
      { id: "successor", type: "user", time: { created: successorTime } },
      { id: "other", type: "assistant", time: { created: 100 }, content: [{ type: "text", text: "other work" }] },
    ] });
    const driver = new OpenCodeHttpDriver({ url, passwordFile: path.join(root, "pw") });
    expect(await driver.progressMessages(sid, "target")).toEqual([{ id: "own", content: [{ type: "text", text: "own work" }] }]);
  });

  it("finds and holds a foreign in-flight turn whose prompt is older than one page", async () => {
    // A turn that has run for hours: hundreds of assistant messages sit after the single user prompt, so the
    // newest page holds no user message. A retry run used to fail with "active session has no user message".
    messagePageSize = 2;
    const sid = sessionIdFor(scope);
    const orphan = messageIdFor(narOpIdFor("run-1"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, model: { providerID: "openai", id: "fixture", variant: "medium" }, time: { created: clock++ } },
      msgs: [{ id: orphan, type: "user", text: "Full assignment", time: { created: clock++ } },
        ...Array.from({ length: 5 }, (_, i) => ({ id: `msg_work${i}`, type: "assistant", time: { created: clock++ }, content: [{ type: "tool", name: "read" }] }))] });
    active.add(sid);
    const finish = () => {
      const s = sessions.get(sid)!;
      s.msgs.push({ id: "msg_done", type: "assistant", time: { created: clock++, completed: clock++ },
        content: [{ type: "text", text: "long turn finished" }], cost: 0.25, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.info.time.idle = clock++;
      s.info.outcome = "succeeded";
      active.delete(sid);
    };
    const saved: unknown[] = [];
    const retry = await execute({ ...context("run-1-retry", { nativeRuntime: "nar" }),
      onSession: async (session: unknown) => { saved.push(session); },
      onLog: async (_stream: string, chunk: string) => { if (chunk.includes("nar_rejoin")) finish(); } } as never);
    expect(promptPosts).toBe(0);
    expect(interruptPosts).toBe(0);
    expect(userMsgs().map((m) => m.id)).toEqual([orphan]);
    expect(saved).toMatchObject([{ sessionParams: { narBinding: { messageId: orphan, kind: "rejoin" } } }]);
    expect(retry).toMatchObject({ exitCode: 75, sessionId: sid, summary: "",
      resultJson: { executionRecovery: { providerWorkStarted: true, reason: expect.stringMatching(/^unowned_turn_(verified_idle|settled)$/) } } });
  }, 15_000);

  it("holds an explicit pause when the active turn cannot be interrupted atomically", async () => {
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
    expect(stopped.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true } });
    expect(stopped.resultJson).not.toHaveProperty("executionCancellation.state", "acknowledged");
    expect(promptPosts).toBe(1);
    expect(interruptPosts).toBe(0);
    expect(active.size).toBe(1);
    expect(userMsgs()).toHaveLength(1);
    expect(runProcess).not.toHaveBeenCalled();
  }, 30_000);

  it("does not stop another run's turn when a retry observing it is stopped", async () => {
    const sid = sessionIdFor(scope);
    const other = messageIdFor(narOpIdFor("run-original"));
    sessions.set(sid, { info: { id: sid, location: { directory: root }, model: { providerID: "openai", id: "qwen", variant: "medium" }, time: { created: clock++ } },
      msgs: [{ id: other, type: "user", text: "Original assignment", time: { created: clock++ } }] });
    active.add(sid);
    const controller = new AbortController();
    let rejoined = false;
    const observer = execute({ ...context("run-retry", { nativeRuntime: "nar", model: "openai/qwen" }), signal: controller.signal,
      onLog: async (_stream: string, chunk: string) => { if (chunk.includes("NAR rejoined in-flight")) rejoined = true; } } as never);
    await vi.waitFor(() => expect(rejoined).toBe(true));
    controller.abort(Object.assign(new Error("Stop observer"), { code: "paperclip_explicit_run_stop" }));
    const result = await observer;
    expect(result.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true } });
    expect(result.resultJson).not.toHaveProperty("executionCancellation.state", "acknowledged");
    expect(interruptPosts).toBe(0);
    expect(promptPosts).toBe(0);
    expect(active.has(sid)).toBe(true);
    expect(userMsgs().map((m) => m.id)).toEqual([other]);
  });

  it("holds when the OpenCode server identity changes mid-run", async () => {
    autoComplete = false;
    const run = execute({ ...context("run-restart", { nativeRuntime: "nar" }, "issue-one"), signal: new AbortController().signal } as never);
    await vi.waitFor(() => expect(active.size).toBe(1));
    serverPid = 9999; // launchd restarted the server
    try {
      const out = await run;
      expect(out.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true, reason: "server_identity_changed" } });
      expect(out.resultJson).not.toHaveProperty("executionCancellation.state", "acknowledged");
    } finally { serverPid = 4242; }
  }, 30_000);

  it("holds when the session goes idle without an outcome for the original message", async () => {
    autoComplete = false;
    const run = execute({ ...context("run-idle-dead", { nativeRuntime: "nar" }, "issue-one"), signal: new AbortController().signal } as never);
    await vi.waitFor(() => expect(active.size).toBe(1));
    active.clear(); // e.g. compaction.interrupted: idle, no outcome recorded
    const out = await run;
    expect(out.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: true, reason: "idle_outcome_unknown" } });
    expect(out.resultJson).not.toHaveProperty("executionCancellation.state", "acknowledged");
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

    const resumed = await execute({ ...context("run-shutdown", { nativeRuntime: "nar" }),
      context: { taskId: scope.issueId, paperclipRestartReattach: true },
      onLog: async (_stream: string, chunk: string) => {
        if (chunk.includes("nar_rejoin")) {
          const session = sessions.get(sid)!;
          session.msgs.push({ id: "msg_resumed_done", type: "assistant", time: { created: clock++, completed: clock++ },
            content: [{ type: "text", text: "owned turn finished" }] });
          session.info.time.idle = clock++; session.info.outcome = "succeeded"; active.delete(sid);
        }
      },
    } as never);
    expect(resumed).toMatchObject({ exitCode: 0, summary: "owned turn finished", sessionId: sid });
    expect(promptPosts).toBe(1);
    expect(interruptPosts).toBe(0);
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

  it("forwards the plain CLI child spawn to the controller", async () => {
    const onSpawn = vi.fn(async () => {});
    runProcess.mockImplementationOnce(async (_runId, _target, _command, _args, options) => {
      await options.onSpawn?.({ pid: 12345, processGroupId: 12345, startedAt: "test" });
      return { exitCode: 0, signal: null, timedOut: false,
        stdout: JSON.stringify({ type: "text", sessionID: "ses_legacy1234", part: { text: "legacy" } }), stderr: "", pid: 12345, startedAt: "" } as never;
    });
    await execute({ ...context("legacy-spawn", { sharedServerRecoveryConfigPath: "" }), onSpawn } as never);
    expect(onSpawn).toHaveBeenCalledWith({ pid: 12345, processGroupId: 12345, startedAt: "test" });
  });
});
