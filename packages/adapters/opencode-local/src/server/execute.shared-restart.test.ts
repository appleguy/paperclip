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

const runProcess = vi.mocked(runAdapterExecutionTargetProcess);
const sid = "ses_exactrestart1234";

describe("OpenCode adapter reconnects to persistent server after SIGTERM", () => {
  let root: string;
  let cfg: string;
  let cli: string;
  let server: Server;
  const active = new Set<string>();
  let created = 0;
  const interrupted: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-repair-adapter-"));
    cli = path.join(root, "fake-opencode");
    await fs.writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    active.clear();
    created = 0;
    interrupted.length = 0;
    vi.stubEnv("XDG_CONFIG_HOME", root);
    runProcess.mockReset();
    const expected = "Basic " + Buffer.from("opencode:local-secret").toString("base64");
    const reply = (res: import("node:http").ServerResponse, status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
    };
    server = createServer((req, res) => {
      if (req.headers.authorization !== expected) return reply(res, 401, {});
      const endpoint = req.url ?? "";
      if (req.method === "GET" && endpoint === "/api/session/active") {
        return reply(res, 200, Object.fromEntries([...active].map(x => [x, { type: "running" }])));
      }
      if (req.method === "POST" && endpoint === "/api/session") {
        created++;
        return reply(res, 200, { id: sid });
      }
      if (req.method === "GET" && endpoint === "/api/session/" + sid)
        return reply(res, 200, { id: sid });
      if (req.method === "POST" && endpoint === "/api/session/" + sid + "/interrupt") {
        interrupted.push(sid);
        active.delete(sid);
        return reply(res, 200, { interrupted: true });
      }
      return reply(res, 404, {});
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const passwordFile = path.join(root, "pw");
    await fs.writeFile(passwordFile, "local-secret", { mode: 0o600 });
    cfg = path.join(root, "shared.json");
    await fs.writeFile(cfg, JSON.stringify({ url, passwordFile }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await fs.rm(root, { force: true, recursive: true });
  });

  const context = (runId: string, taskId = "issue-one") => ({
    runId,
    agent: { id: "agent-one", companyId: "company-one", name: "OpenCode Fixture",
      adapterType: "opencode_local", adapterConfig: {} },
    // Paperclip may lose sessionIdBefore after the process dies.
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: taskId },
    config: { command: cli, cwd: root, model: "openai/fixture",
      sharedServerRecoveryConfigPath: cfg, bootstrapPromptTemplate: "bootstrap-only",
      promptTemplate: "Full assignment", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
    context: { taskId, paperclipTaskMarkdown: "Finish SCO-337",
      paperclipWake: { reason: "source_scoped_recovery_action", recovery: true } },
    onLog: async () => {},
  });

  it("holds server-side work on SIGTERM and does not replay while the session is active", async () => {
    const completed = JSON.stringify({ type: "tool_use", sessionID: sid,
      part: { state: { status: "completed", output: "already written" } } });
    runProcess.mockImplementationOnce(async () => {
      active.add(sid); // The server keeps running after client SIGTERM.
      return { exitCode: null, signal: "SIGTERM", timedOut: false,
        stdout: completed, stderr: "", pid: 12, startedAt: "" } as never;
    }).mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false,
      stdout: JSON.stringify({ type: "text", sessionID: sid, part: { text: "done" } }),
      stderr: "", pid: 13, startedAt: "" } as never);

    const initial = await execute(context("first-run"));
    expect(initial).toMatchObject({ signal: "SIGTERM", sessionId: sid,
      resultJson: { executionRecovery: { providerWorkStarted: true, reason: "shared_session_unverified" } } });
    expect(interrupted).toEqual([]);
    expect(active.has(sid)).toBe(true);
    const held = await execute(context("successor-run"));
    expect(held).toMatchObject({ exitCode: 75, resultJson: { executionRecovery: { providerWorkStarted: true } } });
    expect(runProcess).toHaveBeenCalledTimes(1);
    active.delete(sid);
    const idleHeld = await execute(context("successor-run"));
    expect(idleHeld).toMatchObject({ exitCode: 75 });
    expect(created).toBe(1);
    expect(runProcess).toHaveBeenCalledTimes(1);
    for (const call of runProcess.mock.calls) {
      const args = call[3];
      expect(args).toContain("--session");
      expect(args[args.indexOf("--session") + 1]).toBe(sid);
      expect(args).not.toContain("--fork");
    }
  });

  it("refuses a fresh prompt when a different persistent session is still running", async () => {
    active.add("ses_someforeign12345");
    const result = await execute(context("second-run"));
    expect(result).toMatchObject({ exitCode: 75, timedOut: false,
      errorMessage: "OpenCode shared server has unresolved active sessions; no inference sent" });
    expect(runProcess).not.toHaveBeenCalled();
    expect(created).toBe(0);
    expect(interrupted).toEqual([]);
  });

  it.each(["clean", "signal", "throws"] as const)("only reports provider stopped for a shared CLI %s outcome", async outcome => {
    const stopped = vi.fn(async () => {});
    runProcess.mockImplementationOnce(async (...args) => {
      args[4].onProcessStopped?.();
      if (outcome === "throws") throw new Error("local client failure");
      return { exitCode: outcome === "clean" ? 0 : null, signal: outcome === "signal" ? "SIGTERM" : null,
        timedOut: false, stdout: "", stderr: "", pid: 12, startedAt: "" } as never;
    });
    const result = execute({ ...context("callback-run"), onProviderStopped: stopped });
    if (outcome === "throws") await expect(result).resolves.toMatchObject({ resultJson: {
      executionRecovery: { reason: "shared_session_unverified", providerWorkStarted: true },
    } });
    else await result;
    expect(stopped).toHaveBeenCalledTimes(outcome === "clean" ? 1 : 0);
  });
});
