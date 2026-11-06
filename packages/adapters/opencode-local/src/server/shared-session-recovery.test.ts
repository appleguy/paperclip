import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { prepareSharedOpenCodeSession, OpenCodeSharedSessionWait } from "./shared-session-recovery.js";

type ProviderState = {
  sessions: Set<string>;
  active: Set<string>;
  created: number;
  interrupted: string[];
  requests: string[];
  refuseInterrupt?: boolean;
  failedAuth?: boolean;
};

describe("persistent OpenCode server restart re-pair", () => {
  let root: string;
  let server: Server;
  let cfg: string;
  let state: ProviderState;
  const previousId = "ses_mock_persistent_001";
  const currentId = "ses_mock_persistent_002";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-owned-"));
    state = { sessions: new Set(), active: new Set(), created: 0, interrupted: [], requests: [] };
    server = createServer(async (req, res) => {
      const auth = Buffer.from("opencode:test-only-password").toString("base64");
      if (req.headers.authorization !== `Basic ${auth}` || state.failedAuth) {
        res.writeHead(401).end("{}"); return;
      }
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      state.requests.push((req.method ?? "") + " " + url.pathname);
      const write = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: value }));
      };
      if (url.pathname === "/api/session/active" && req.method === "GET") {
        write(Object.fromEntries([...state.active].map(id => [id, { type: "running" }])));
      } else if (url.pathname === "/api/session" && req.method === "POST") {
        state.created++;
        const id = state.created === 1 ? previousId : currentId;
        state.sessions.add(id);
        write({ id });
      } else if (/^\/api\/session\/ses_[\w-]+$/.test(url.pathname) && req.method === "GET") {
        const id = url.pathname.split("/").at(-1)!;
        if (!state.sessions.has(id)) write(null, 404);
        else write({ id });
      } else if (/^\/api\/session\/ses_[\w-]+\/interrupt$/.test(url.pathname) && req.method === "POST") {
        const id = url.pathname.split("/").at(-2)!;
        if (state.refuseInterrupt) write({ interrupted: false });
        else { state.interrupted.push(id); state.active.delete(id); write({ interrupted: true }); }
      } else write(null, 404);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected listener");
    const passwordFile = path.join(root, "password");
    cfg = path.join(root, "shared.json");
    await fs.writeFile(passwordFile, "test-only-password\n", { mode: 0o600 });
    await fs.writeFile(cfg, JSON.stringify({
      url: `http://127.0.0.1:${address.port}`, passwordFile,
    }), { mode: 0o600 });
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  function input(runId: string, changes: Record<string, unknown> = {}) {
    return { configPath: cfg, stateDir: root, agentId: "agent-test",
      taskId: "issue-test", runId, cwd: path.join(root, "workspace"),
      requestedSessionId: null, ...changes };
  }

  it("holds a still-active bound session after controller loss without interrupting a successor", async () => {
    const original = await prepareSharedOpenCodeSession(input("run-before-crash"));
    expect(original.sessionId).toBe(previousId);
    expect(original.resumed).toBe(false);
    const journal = path.join(root, "paperclip-opencode-session-recovery", "agent-test-issue-test.json");
    const saved = JSON.parse(await fs.readFile(journal, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ sessionId: previousId, runId: "run-before-crash" });
    expect((await fs.stat(journal)).mode & 0o777).toBe(0o600);
    // Simulate losing the Paperclip client while the persistent provider keeps
    // generating. No finish() is called: the new process sees ONLY durable state.
    state.sessions.add(previousId);
    state.active.add(previousId);
    await expect(prepareSharedOpenCodeSession(input("run-after-crash"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.interrupted).toEqual([]);
    expect(state.active.has(previousId)).toBe(true);
    expect(JSON.parse(await fs.readFile(journal, "utf8"))).toMatchObject({ runId: "run-before-crash" });
    state.active.delete(previousId);
    await expect(prepareSharedOpenCodeSession(input("run-after-crash"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(1);
    expect(state.interrupted).toEqual([]);
  });

  it("treats a follow-up after a clean exit as a normal resume, not a restart recovery", async () => {
    const first = await prepareSharedOpenCodeSession(input("run-clean"));
    await first.finish({ exitCode: 0, signal: null, timedOut: false });
    state.sessions.add(first.sessionId);
    const followUp = await prepareSharedOpenCodeSession(input("run-follow-up"));
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.resumed).toBe(true);
    expect(followUp.recovered).toBe(false);
    // The new run's binding clears the clean marker until it, too, exits cleanly.
    const journal = path.join(root, "paperclip-opencode-session-recovery", "agent-test-issue-test.json");
    expect(JSON.parse(await fs.readFile(journal, "utf8")).exited).toBeUndefined();
    await followUp.finish({ exitCode: 1, signal: null, timedOut: false });
    await expect(prepareSharedOpenCodeSession(input("run-after-failure"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
  });

  it("holds unverified provider work on shutdown without interrupting the session", async () => {
    const controller = new AbortController();
    const current = await prepareSharedOpenCodeSession(input("run-before-shutdown", { signal: controller.signal }));
    state.active.add(current.sessionId);
    controller.abort();
    expect(await current.finish({ exitCode: null, signal: "SIGTERM", timedOut: false })).toEqual({ providerWorkUnverified: true });
    expect(state.interrupted).toEqual([]);
    expect(state.active.has(current.sessionId)).toBe(true);
    await expect(prepareSharedOpenCodeSession(input("run-after-shutdown"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    state.active.delete(current.sessionId);
    await expect(prepareSharedOpenCodeSession(input("run-after-shutdown"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(1);
  });

  it("holds a foreign active session instead of stealing or interrupting it", async () => {
    state.sessions.add("ses_foreign_session_9");
    state.active.add("ses_foreign_session_9");
    await expect(prepareSharedOpenCodeSession(input("our-run"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(0);
    expect(state.interrupted).toEqual([]);
  });

  it("refuses an active session with only a legacy session ID and no durable ownership receipt", async () => {
    state.sessions.add(previousId);
    state.active.add(previousId);
    await expect(prepareSharedOpenCodeSession(input("unproven", {
      requestedSessionId: previousId,
    }))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.interrupted).toEqual([]);
  });

  it("does not steal another run's changed workspace, session binding or server", async () => {
    const original = await prepareSharedOpenCodeSession(input("original"));
    for (const changes of [
      { cwd: "/other/workspace" }, { requestedSessionId: currentId },
    ]) {
      await expect(prepareSharedOpenCodeSession(input("new-run", changes))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    }
    expect(original.sessionId).toBe(previousId);
    expect(state.created).toBe(1);
  });

  it("holds an active bound session without attempting an interrupt", async () => {
    await prepareSharedOpenCodeSession(input("original"));
    state.active.add(previousId);
    state.refuseInterrupt = true;
    await expect(prepareSharedOpenCodeSession(input("successor"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(1);
  });

  it("fails closed if the provider no longer recognizes the previously bound session", async () => {
    await prepareSharedOpenCodeSession(input("original"));
    state.sessions.clear();
    await expect(prepareSharedOpenCodeSession(input("successor"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(1);
  });

  it("never redirects credentials or performs mutation after auth rejection", async () => {
    state.failedAuth = true;
    await expect(prepareSharedOpenCodeSession(input("bad-auth"))).rejects.toBeInstanceOf(OpenCodeSharedSessionWait);
    expect(state.created).toBe(0);
    expect(state.interrupted).toHaveLength(0);
  });
});
