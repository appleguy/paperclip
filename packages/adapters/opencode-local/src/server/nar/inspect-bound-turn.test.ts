import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectBoundOpenCodeTurn } from "./inspect-bound-turn.js";
import { messageIdFor, sessionIdFor } from "./opencode-http-driver.js";
import { narOpIdFor } from "./nar-attempt.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(process.env.PAPERCLIP_TMPDIR ?? os.tmpdir(), "opencode-inspect-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(options: { successorAt?: number; pid?: number; active?: boolean } = {}) {
  const configPath = path.join(dir, "config.json"), passwordFile = path.join(dir, "password");
  const origin = "http://127.0.0.1:4096", runId = "run-one", agentId = "agent-one", taskId = "task-one";
  const sessionId = sessionIdFor({ agentId, issueId: taskId }), messageId = messageIdFor(narOpIdFor(runId));
  await writeFile(configPath, JSON.stringify({ url: origin, passwordFile }));
  await writeFile(passwordFile, "fixture");
  const calls: string[] = [];
  let historyReads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init?.method} ${pathname}`);
    if (pathname === "/api/info") return Response.json({ version: "2.2.5", pid: options.pid ?? 123, urls: [origin] });
    if (pathname === "/api/session/active") return Response.json({ data: options.active ? { [sessionId]: {} } : {} });
    if (pathname === `/api/session/${sessionId}/message`) return Response.json({ data: [
      ...(++historyReads >= (options.successorAt ?? Infinity) ? [{ id: "msg_successor", type: "user" }] : []),
      { id: messageId, type: "user", time: { created: 1 } },
    ] });
    if (pathname === `/api/session/${sessionId}/message/${messageId}`)
      return Response.json({ data: { id: messageId, type: "user", time: { created: 1 } } });
    if (pathname === `/api/session/${sessionId}/inbox`) return Response.json({ data: [] });
    if (pathname === `/api/session/${sessionId}`) return Response.json({ data: {
      id: sessionId, location: { directory: dir }, time: { idle: 2 }, outcome: "interrupted",
    } });
    return new Response(null, { status: 404 });
  };
  const earlySession = { sessionId, sessionParams: { sessionId, cwd: dir, narBinding: {
    schema: "paperclip.opencode-binding.v1", runId, agentId, taskId, kind: "submit", messageId,
    configPath, hostPid: 123, providerOrigin: origin,
  } } };
  return { input: { runId, agentId, taskId, cwd: dir, configPath, earlySession, fetchImpl }, calls };
}

it("observes only the recorded owned turn without sending a mutation", async () => {
  const f = await fixture();
  expect(await inspectBoundOpenCodeTurn(f.input)).toEqual({ state: "observed_idle", reason: "target_idle_at_observation" });
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every(call => call.startsWith("GET "))).toBe(true);
});

it("holds a foreign or malformed binding before provider contact", async () => {
  const f = await fixture();
  f.input.earlySession.sessionParams.narBinding.runId = "other-run";
  expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "binding_invalid_or_unowned" });
  expect(f.calls).toEqual([]);
});

it("does not claim an observed rejoined turn as this run's submission", async () => {
  const f = await fixture();
  f.input.earlySession.sessionParams.narBinding.kind = "rejoin";
  expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "binding_invalid_or_unowned" });
  expect(f.calls).toEqual([]);
});

it("holds when the configured provider endpoint no longer matches the binding", async () => {
  const f = await fixture();
  f.input.earlySession.sessionParams.narBinding.providerOrigin = "http://127.0.0.1:1234";
  expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "provider_changed" });
  expect(f.calls).toEqual([]);
});

it("rejects a recorded session outside the agent and task scope", async () => {
  const f = await fixture();
  f.input.earlySession.sessionId = "ses_foreign";
  f.input.earlySession.sessionParams.sessionId = "ses_foreign";
  expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "session_not_in_scope" });
  expect(f.calls).toEqual([]);
});

it("holds when a successor appears during inspection or the target remains active", async () => {
  for (const options of [{ successorAt: 2 }, { active: true }]) {
    const f = await fixture(options);
    expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "target_not_verified_idle" });
    expect(f.calls.every(call => call.startsWith("GET "))).toBe(true);
  }
});

it("holds when the provider process identity changes", async () => {
  const f = await fixture({ pid: 124 });
  expect(await inspectBoundOpenCodeTurn(f.input)).toMatchObject({ state: "unverified", reason: "provider_unavailable_or_changed" });
  expect(f.calls.every(call => call.startsWith("GET "))).toBe(true);
});
