import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHANNEL_NAME, findBridgeRoot, prepareChannelHost, routeChannelInput, type ChannelIO, type ChannelStatus,
} from "./channel.js";
import { isClaudeIdle } from "./execute.js";
import { adoptableActive } from "../agy/execute.js";

const homes: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-channel-w3b-"));
  homes.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const opId = "d3e466b4-53b7-4d17-ae8d-87dd89ad2be3";
const issueId = "sco-337-test";
const idle = ["──────────────────────────────", "❯ ", "──────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const typed = idle.replace("❯ ", "❯ owner is typing");
const state = (stage: ChannelStatus["stage"]): ChannelStatus => ({
  op_id: opId, stage, hook_observed: stage === "hook_observed" || stage === "terminal",
  held_unknown_effect: false, receipt: null,
});

describe("claude_rc_local channel dispatch", () => {
  it("submits exactly once and accepts only hook observation (not local emission)", async () => {
    let stage: ChannelStatus | null = null;
    let pushes = 0;
    const io: ChannelIO = {
      ready: async () => true,
      status: async () => stage,
      submit: async () => { pushes++; stage = state("emitted_local"); return { ok: true }; },
      fallback: async () => { throw new Error("must not type"); },
    };
    // First notification is only emitted_local, then independent hook confirms.
    const finish = routeChannelInput(opId, "hello from Paperclip", false, io, { pollMs: 5, hookWaitMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(pushes).toBe(1);
    stage = state("hook_observed");
    await expect(finish).resolves.toBe("channel");
    await expect(routeChannelInput(opId, "hello again", false, io)).rejects.toThrow(/already exists/);
    expect(pushes).toBe(1);
  });

  it("adopts a restart checkpoint with emitted_local without any replay", async () => {
    const dir = await tmp();
    const active = {
      runId: opId, issueId, op_id: opId, rcUrl: "https://claude.ai/code/session_test",
      receiptPath: path.join(dir, `receipt-${opId}.json`), conversationId: "provider-conversation",
      dispatchMode: "channel-pending",
    };
    const activeFile = path.join(dir, "active.json");
    await fs.writeFile(activeFile, JSON.stringify(active));
    const adopted = adoptableActive(await fs.readFile(activeFile, "utf8"), issueId, dir);
    expect(adopted?.runId).toBe(opId);
    let submits = 0;
    const io: ChannelIO = {
      ready: async () => { throw new Error("adoption must not await new channel"); },
      status: async () => state("emitted_local"),
      submit: async () => { submits++; return { ok: true }; },
      fallback: async () => { throw new Error("adoption must not type"); },
    };
    await expect(routeChannelInput(active.op_id, "do not replay", Boolean(adopted), io)).resolves.toBe("adopted");
    expect(submits).toBe(0);
  });

  it("allows channel-down tmux fallback only with an empty idle editor", async () => {
    let fallbackCount = 0;
    let screen = typed;
    const io: ChannelIO = {
      ready: async () => false,
      status: async () => null,
      submit: async () => { throw new Error("unavailable channel must never submit"); },
      fallback: async () => {
        if (!isClaudeIdle(screen)) throw new Error("editor is nonempty or busy");
        fallbackCount++;
      },
    };
    await expect(routeChannelInput(opId, "x", false, io, { readyWaitMs: 0 })).rejects.toThrow(/nonempty/);
    expect(fallbackCount).toBe(0);
    screen = idle;
    await expect(routeChannelInput(opId, "x", false, io, { readyWaitMs: 0 })).resolves.toBe("tmux-fallback");
    expect(fallbackCount).toBe(1);
    io.status = async () => state("emitted_local");
    await expect(routeChannelInput(opId, "x", false, io, { readyWaitMs: 0 })).rejects.toThrow(/already exists/);
    expect(fallbackCount).toBe(1);
  });

  it("creates private channel/hook configs with no token or auth material and submits via stdin", async () => {
    const dir = await tmp();
    const root = await findBridgeRoot();
    const host = await prepareChannelHost(dir, root);
    const mcpText = await fs.readFile(host.mcpConfigPath, "utf8");
    const hooksText = await fs.readFile(host.hookSettingsPath, "utf8");
    const mcp = JSON.parse(mcpText);
    expect(Object.keys(mcp.mcpServers)).toEqual([CHANNEL_NAME]);
    expect(Object.keys(mcp.mcpServers[CHANNEL_NAME].env).sort()).toEqual(["PC_BRIDGE_DIR", "PC_BRIDGE_SERVER"]);
    expect(mcpText).not.toMatch(/token|password|authorization|Bearer|api[_-]?key/i);
    expect(hooksText).not.toMatch(/token|password|authorization|Bearer|api[_-]?key/i);
    expect(hooksText).toContain("UserPromptSubmit");
    expect(hooksText).toContain("SessionStart");
    expect((await fs.stat(host.mcpConfigPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(host.hookSettingsPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(host.dir)).mode & 0o777).toBe(0o700);
    expect(await host.ready()).toBe(false);
    const prompt = "Multi\nline prompt, not an argv token: fake-private-value-987";
    await expect(host.submit(opId, prompt)).resolves.toMatchObject({ ok: true });
    await expect(host.status(opId)).resolves.toMatchObject({ stage: "inbox_pending", held_unknown_effect: true });
    expect(JSON.parse(await fs.readFile(path.join(host.dir, "inbox", `${opId}.json`), "utf8")))
      .toEqual({ op_id: opId, content: prompt });
    await expect(host.submit(opId, prompt)).rejects.toThrow(/duplicate_op_id/);
  });
});
