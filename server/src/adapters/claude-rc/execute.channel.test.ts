import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CHANNEL_NAME, findBridgeRoot, prepareChannelHost, routeChannelInput, type ChannelIO, type ChannelStatus,
} from "./channel.js";
import { isPromptEmpty } from "./execute.js";
import { adoptableActive } from "../agy/execute.js";

const homes: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-channel-w3b-"));
  homes.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
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
  it("retains one admitted op through a long native turn and delivers once at its hook boundary", async () => {
    const dir = await tmp();
    const root = await findBridgeRoot();
    const host = await prepareChannelHost(dir, root);
    const { Ledger, processInbox, handleHook } = createRequire(import.meta.url)(path.join(root, "lib/bridge.cjs"));
    const ledger = new Ledger(host.dir);
    const receipt = path.join(dir, "receipt.json");
    const submit = vi.fn(host.submit);
    const fallback = vi.fn(async () => { throw new Error("must not touch the live pane"); });
    const io: ChannelIO = {
      ready: async () => true, status: host.status, submit, fallback,
      observe: () => host.observeInput(opId, receipt),
    };
    let finished = false;
    const pending = routeChannelInput(opId, "retain this op", false, io).then(result => { finished = true; return result; });
    await vi.waitFor(async () => expect(await host.status(opId)).toMatchObject({ stage: "inbox_pending" }));
    const nativeQueue: string[] = [];
    await processInbox(ledger, async (id: string) => { nativeQueue.push(id); });
    await vi.waitFor(async () => expect(await host.status(opId)).toMatchObject({ stage: "emitted_local" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    // Stop is a wake hint, not proof that a channel prompt was admitted or a foreign op settled.
    handleHook(ledger, CHANNEL_NAME, "Stop", { session_id: "original-session" });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    await expect(routeChannelInput(opId, "duplicate wake", false, io)).rejects.toThrow(/already exists/);
    const adopted = routeChannelInput(opId, "never replay", true, io);
    handleHook(ledger, CHANNEL_NAME, "UserPromptSubmit", {
      session_id: "original-session", prompt: `<channel source="${CHANNEL_NAME}" op_id="${opId}">retain this op</channel>`,
    });
    await expect(pending).resolves.toBe("channel");
    await expect(adopted).resolves.toBe("adopted");
    expect(submit).toHaveBeenCalledOnce();
    expect(nativeQueue).toEqual([opId]);
    expect(await processInbox(ledger, async () => { throw new Error("duplicate native delivery"); })).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    expect(ledger.events().filter((e: { ev: string }) => e.ev === "hook_observed")).toHaveLength(1);
  });

  it("cancels only the observer and retains the original op for reattach without resubmission", async () => {
    const dir = await tmp();
    const host = await prepareChannelHost(dir, await findBridgeRoot());
    const abort = new AbortController();
    const submit = vi.fn(host.submit);
    const io: ChannelIO = { ready: async () => true, status: host.status, submit,
      observe: () => host.observeInput(opId, path.join(dir, "receipt.json"), abort.signal),
      fallback: async () => { throw new Error("must not paste"); } };
    const pending = routeChannelInput(opId, "original work", false, io);
    const rejected = expect(pending).rejects.toThrow(/pending op retained/);
    await vi.waitFor(async () => expect(await host.status(opId)).toMatchObject({ stage: "inbox_pending" }));
    abort.abort();
    await rejected;
    expect(await host.status(opId)).toMatchObject({ stage: "inbox_pending" });
    expect(submit).toHaveBeenCalledOnce();
    // A receipt wakes observation but does not masquerade as hook admission.
    const receiptPath = path.join(dir, "receipt.json");
    const adopted = routeChannelInput(opId, "do not submit", true, {
      ...io, observe: () => host.observeInput(opId, receiptPath),
    });
    await fs.writeFile(receiptPath, "unvalidated receipt: the adapter owns its gate");
    await expect(adopted).resolves.toBe("adopted");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("holds uncertain bridge effects until their original hook arrives without fallback", async () => {
    const dir = await tmp();
    const root = await findBridgeRoot();
    const host = await prepareChannelHost(dir, root);
    const { Ledger, processInbox, handleHook } = createRequire(import.meta.url)(path.join(root, "lib/bridge.cjs"));
    const ledger = new Ledger(host.dir);
    await host.submit(opId, "original work");
    await processInbox(ledger, async () => {});
    ledger.recover(); // No hook after bridge restart: uncertainty remains held.
    await expect(host.observeInput(opId, path.join(dir, "receipt.json"))).rejects.toThrow(/unknown-effect/);
    expect(ledger.terminal(opId, "block", { reason: "not yet admitted" }).ok).toBe(false);
    handleHook(ledger, CHANNEL_NAME, "UserPromptSubmit", {
      prompt: `<channel source="${CHANNEL_NAME}" op_id="${opId}">original work</channel>`,
    });
    expect(ledger.terminal(opId, "block", { reason: "original op blocked" }).ok).toBe(true);
    await expect(host.observeInput(opId, path.join(dir, "receipt.json"))).resolves.toBe("hook");
    expect(await host.status(opId)).toMatchObject({ stage: "terminal", hook_observed: true });
  });

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

  it("keeps waiting while a just-submitted op is inbox_pending (held only to block resubmit)", async () => {
    let stage: ChannelStatus | null = null;
    let pushes = 0;
    const io: ChannelIO = {
      ready: async () => true,
      status: async () => stage,
      submit: async () => {
        pushes++;
        stage = { op_id: opId, stage: "inbox_pending", hook_observed: false, held_unknown_effect: true, receipt: null };
        return { ok: true };
      },
      fallback: async () => { throw new Error("must not type"); },
    };
    const finish = routeChannelInput(opId, "queued then reserved", false, io, { pollMs: 5, hookWaitMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(pushes).toBe(1);
    stage = state("hook_observed");
    await expect(finish).resolves.toBe("channel");
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

  it("allows channel-down tmux fallback while busy and refuses owner input", async () => {
    let fallbackCount = 0;
    let screen = typed;
    const io: ChannelIO = {
      ready: async () => false,
      status: async () => null,
      submit: async () => { throw new Error("unavailable channel must never submit"); },
      fallback: async () => {
        if (!isPromptEmpty(screen)) throw new Error("editor is nonempty");
        fallbackCount++;
      },
    };
    await expect(routeChannelInput(opId, "x", false, io, { readyWaitMs: 0 })).rejects.toThrow(/nonempty/);
    expect(fallbackCount).toBe(0);
    screen = "✻ Thinking… (esc to interrupt)\n" + idle;
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
