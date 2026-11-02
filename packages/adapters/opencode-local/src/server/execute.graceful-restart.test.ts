import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { execute } from "./execute.js";

const runProcess = vi.mocked(runAdapterExecutionTargetProcess);

const processResult = (overrides: Record<string, unknown> = {}) => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
  pid: 123, startedAt: "2026-11-02T12:00:00.000Z",
  ...overrides,
}) as never;

describe("OpenCode graceful SIGTERM and same-session continuity", () => {
  let dir: string;
  let command: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-restart-"));
    command = path.join(dir, "fixture-opencode");
    await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    runProcess.mockReset();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const contextFor = (sessionId: string | null = null, sessionParams: Record<string, unknown> | null = null) => ({
    runId: "restart-run",
    agent: { id: "agent-1", companyId: "company-1", name: "Restart Fixture",
      adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId, sessionParams, sessionDisplayId: sessionId, taskKey: "issue-1" },
    config: { command, cwd: dir, model: "openai/fixture",
      bootstrapPromptTemplate: "This is initial bootstrap, not a recovery prompt.",
      promptTemplate: "Complete the assigned issue.",
      env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
    context: { paperclipTaskMarkdown: "SCO-337 recovery task",
      paperclipWake: { reason: "source_scoped_recovery_action", recovery: true } },
    onLog: async () => {},
  });

  it("does not restart a fresh session after SIGTERM plus an unknown-session error", async () => {
    runProcess.mockResolvedValueOnce(processResult({
      exitCode: null, signal: "SIGTERM",
      stdout: JSON.stringify({ type: "error", error: "unknown session" }),
    }));
    const result = await execute(contextFor("previous"));
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result.signal).toBe("SIGTERM");
    expect(result.sessionId).toBe("previous");
    expect(result.errorMessage).toContain("unknown session");
  });

  it("retains a signalled run's provider session and resumes that exact session on the next wake", async () => {
    const toolCompleted = JSON.stringify({ type: "tool_use", sessionID: "ses_existing",
      part: { state: { status: "completed", output: "file updated" } } });
    runProcess.mockResolvedValueOnce(processResult({
      exitCode: null, signal: "SIGTERM", stdout: toolCompleted,
    })).mockResolvedValueOnce(processResult({
      stdout: JSON.stringify({ type: "text", sessionID: "ses_existing", part: { text: "Finished remaining work" } }),
    }));

    const first = await execute(contextFor());
    expect(first).toMatchObject({ signal: "SIGTERM", sessionId: "ses_existing" });
    expect(runProcess).toHaveBeenCalledTimes(1);

    const next = await execute(contextFor(first.sessionId ?? null, first.sessionParams));
    expect(next).toMatchObject({ exitCode: 0, sessionId: "ses_existing" });
    expect(runProcess).toHaveBeenCalledTimes(2);
    const firstArgs = runProcess.mock.calls[0]![3];
    const secondArgs = runProcess.mock.calls[1]![3];
    expect(firstArgs).not.toContain("--session");
    expect(secondArgs).toContain("--session");
    expect(secondArgs[secondArgs.indexOf("--session") + 1]).toBe("ses_existing");
    expect(secondArgs).not.toContain("--fork");
    const secondPrompt = runProcess.mock.calls[1]![4].stdin as string;
    expect(secondPrompt).not.toContain("This is initial bootstrap");
  });

  it("records a typed, pre-inference 429 only after observing the entire safe stream", async () => {
    const start = JSON.stringify({ type: "step_start", sessionID: "ses_capacity" });
    const refusal = JSON.stringify({ type: "error", sessionID: "ses_capacity", error: {
      type: "provider.rate-limit", status: 429,
      response: { body: JSON.stringify({ src: "llama-swap",
        error: { code: "concurrency_limit", type: "rate_limit_error", message: "Too many requests" } }) },
    } });
    runProcess.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", start + "\n");
      await args[4].onLog("stdout", refusal + "\n");
      return processResult({ exitCode: 1, stdout: start + "\n" + refusal });
    });
    const result = await execute(contextFor());
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: 1, sessionId: "ses_capacity",
      resultJson: { adapterPreInferenceAdmission: {
        kind: "opencode_capacity_refusal_v1", providerWorkStarted: false,
      } },
    });
  });

  it("does not mark a 429 retry-safe if an earlier completed tool fell off the stdout cap", async () => {
    const completed = JSON.stringify({ type: "tool_use", sessionID: "ses_prior",
      part: { state: { status: "completed", output: "write complete" } } });
    const start = JSON.stringify({ type: "step_start", sessionID: "ses_prior" });
    const refusal = JSON.stringify({ type: "error", sessionID: "ses_prior", error: {
      status: 429, type: "provider.rate-limit", message: "Too many requests",
    } });
    runProcess.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", completed + "\n");
      await args[4].onLog("stdout", start + "\n" + refusal + "\n");
      return processResult({ exitCode: 1, stdout: start + "\n" + refusal });
    });
    const result = await execute(contextFor());
    expect(result.exitCode).toBe(1);
    expect(result.resultJson).not.toHaveProperty("adapterPreInferenceAdmission");
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("does not replay a stale session when a completed tool fell off the capped stdout", async () => {
    const completed = JSON.stringify({ type: "tool_use", sessionID: "ses_previous",
      part: { state: { status: "completed", output: "write complete" } } });
    const unknown = JSON.stringify({ type: "error", error: "unknown session" });
    runProcess.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", completed + "\n");
      await args[4].onLog("stdout", unknown + "\n");
      return processResult({ exitCode: 1, stdout: unknown });
    });
    const result = await execute(contextFor("ses_previous"));
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("unknown session");
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
