import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { buildCodexAcpConfig } from "./acp.js";

const bridgeEntry = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp");

// Exercise the installed ACP bridge without a real Codex process, account,
// inference request, or enrolled daemon. Unknown backend calls fail explicitly.
const backend = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const model = 'gpt-6.1-sol';
const thread = { id: 'fixture-thread', status: { type: 'idle' }, turns: [] };
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id == null) continue;
  let result;
  switch (msg.method) {
    case 'initialize': result = { userAgent: 'fixture', codexHome: process.env.CODEX_HOME }; break;
    case 'account/read': result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false }; break;
    case 'config/read': result = { config: {}, origins: {}, layers: [] }; break;
    case 'skills/config/write':
    case 'skills/extraRoots/set': result = {}; break;
    case 'skills/list': result = { data: [] }; break;
    case 'model/list': result = { data: [{ id: model, model, displayName: model,
      description: 'fixture', isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'high' }],
      inputModalities: ['text'], supportsPersonality: false }], nextCursor: null }; break;
    case 'thread/start':
    case 'thread/resume': result = { thread, model, modelProvider: 'openai', reasoningEffort: 'high' }; break;
    case 'thread/read': result = { thread }; break;
    case 'thread/turns/list': result = { data: [], nextCursor: null }; break;
    case 'thread/loaded/list': result = { data: [], nextCursor: null }; break;
    case 'thread/unsubscribe': result = {}; break;
    case 'account/rateLimits/read': result = { rateLimits: null }; break;
    default:
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: 'Unexpected fixture method: ' + msg.method } }));
      continue;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
}
`;

it("pins the retained Codex ACP dependency to the tested bridge", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const installed = JSON.parse(await fs.readFile(path.resolve(bridgeEntry, "../../package.json"), "utf8"));
  expect(manifest.dependencies["@agentclientprotocol/codex-acp"]).toBe("2.5.0");
  expect(installed.version).toBe("2.5.0");
});

it.each([true, false])("propagates bypass=%s to real ACP new and resumed session modes", async (bypass) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-mode-"));
  const fakeCodex = path.join(root, "fake-codex.mjs");
  await fs.writeFile(fakeCodex, backend, { mode: 0o700 });
  const config = buildCodexAcpConfig({ dangerouslyBypassApprovalsAndSandbox: bypass });
  const child = spawn(process.execPath, [bridgeEntry], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      PATH: path.dirname(process.execPath), HOME: root, CODEX_HOME: root,
      CODEX_PATH: fakeCodex, APP_SERVER_LOGS: root,
      ...(config.env as Record<string, string>),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const timer = setTimeout(() => {
    for (const item of pending.values()) item.reject(new Error(`ACP fixture timed out: ${stderr}`));
  }, 10_000);
  try {
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(initialized.agentInfo.version).toBe("2.5.0");
    const opened = await request("session/new", { cwd: root, mcpServers: [] });
    const expected = bypass ? "agent-full-access" : "agent";
    expect(opened.modes.currentModeId).toBe(expected);
    expect(opened.models.currentModelId).toContain("gpt-6.1-sol");
    const resumed = await request("session/load", { sessionId: opened.sessionId, cwd: root, mcpServers: [] });
    expect(resumed.modes.currentModeId).toBe(expected);
  } finally {
    clearTimeout(timer);
    lines.close();
    const exited = once(child, "exit");
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill();
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15_000);
