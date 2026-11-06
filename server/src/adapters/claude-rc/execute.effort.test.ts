import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryAcquire } from "../agy/execute.js";
import { parseSeatLaunch, reconcileIdleSeat, reconcileSeatSettings } from "./execute.js";

const idle = "❯ \n  bypass permissions on (shift+tab to cycle)";
const busy = "✻ Synthesizing… (esc to …)\n❯ \n  bypass permissions on";
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/sco1010-"); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("live Claude settings", () => {
  it("reads the actual macOS ps output, including its trailing newline", () => {
    expect(parseSeatLaunch("123", "Thu Nov  5 13:56:03 2026     /opt/homebrew/bin/claude --model claude-sonnet-5-5 --effort high\n"))
      .toEqual({ identity: "123:Thu Nov  5 13:56:03 2026", model: "claude-sonnet-5-5", effort: "high" });
  });
  it("applies effort drift once and retains it across wakes", async () => {
    const submit = vi.fn(async (_command: string, _confirmed: RegExp) => true);
    const options = { stateDir: dir, identity: "seat-1", launchModel: "sonnet", launchEffort: "high",
      model: "sonnet", effort: "xhigh", screen: async () => idle, submit };
    await reconcileSeatSettings(options);
    await reconcileSeatSettings(options);
    expect(submit.mock.calls.map(call => call[0])).toEqual(["/effort xhigh"]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "applied-settings.json"), "utf8"))).toMatchObject({ effort: "xhigh" });
  });

  it("defers busy or populated prompts, retries unconfirmed commands, and resets on a new process", async () => {
    let screen = busy;
    const submit = vi.fn(async (_command: string, _confirmed: RegExp) => false);
    const options = { stateDir: dir, identity: "seat-1", launchModel: "sonnet", launchEffort: "high",
      model: "opus", effort: "xhigh", screen: async () => screen, submit };
    await reconcileSeatSettings(options);
    screen = "❯ owner text\n  bypass permissions on";
    await reconcileSeatSettings(options);
    expect(submit).not.toHaveBeenCalled();
    screen = idle;
    await reconcileSeatSettings(options);
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockResolvedValue(true);
    await reconcileSeatSettings(options);
    await reconcileSeatSettings({ ...options, identity: "seat-2" });
    expect(submit.mock.calls.map(call => call[0])).toEqual([
      "/model opus", "/model opus", "/effort xhigh", "/model opus", "/effort xhigh",
    ]);
  });

  it("reapplies effort after a model switch even when its configured value did not change", async () => {
    const submit = vi.fn(async (_command: string, _confirmed: RegExp) => true);
    await reconcileSeatSettings({ stateDir: dir, identity: "seat", launchModel: "sonnet", launchEffort: "high",
      model: "opus", effort: "high", screen: async () => idle, submit });
    expect(submit.mock.calls.map(call => call[0])).toEqual(["/model opus", "/effort high"]);
  });

  it("defers behind dispatch and an unresolved checkpoint before reading current settings", async () => {
    const readCurrent = vi.fn(async () => ({ effort: "xhigh" }));
    const apply = vi.fn(async () => true);
    const options = { stateDir: dir, readCurrent, apply };
    const unlock = await tryAcquire(dir);
    expect(unlock).not.toBeNull();
    expect(await reconcileIdleSeat(options)).toBe(false);
    expect(readCurrent).not.toHaveBeenCalled();
    await unlock!();
    await fs.writeFile(path.join(dir, "active.json"), "{}");
    expect(await reconcileIdleSeat(options)).toBe(false);
    expect(readCurrent).not.toHaveBeenCalled();
    await fs.rm(path.join(dir, "active.json"));
    expect(await reconcileIdleSeat(options)).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ effort: "xhigh" });
  });

  it("retries a busy seat with fresh settings and records a confirmed change once", async () => {
    let screen = busy;
    let effort = "high";
    const submit = vi.fn(async (_command: string, _confirmed: RegExp) => true);
    const options = {
      stateDir: dir,
      readCurrent: async () => ({ effort }),
      apply: ({ effort: current }: { effort: string }) => reconcileSeatSettings({
        stateDir: dir, identity: "seat-1", launchModel: "sonnet", launchEffort: "high",
        model: "sonnet", effort: current, screen: async () => screen, submit,
      }),
    };
    effort = "xhigh";
    expect(await reconcileIdleSeat(options)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    screen = idle;
    expect(await reconcileIdleSeat(options)).toBe(true);
    expect(await reconcileIdleSeat(options)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toBe("/effort xhigh");
  });

  it("releases the seat mutex if reading current settings fails", async () => {
    await expect(reconcileIdleSeat({ stateDir: dir, readCurrent: async () => { throw new Error("read failed"); },
      apply: async () => true })).rejects.toThrow("read failed");
    const unlock = await tryAcquire(dir);
    expect(unlock).not.toBeNull();
    await unlock!();
  });

  it("recognizes settings already applied by dispatch after the caller restarts", async () => {
    const submit = vi.fn(async (_command: string, _confirmed: RegExp) => true);
    const settings = { stateDir: dir, identity: "seat-1", launchModel: "sonnet", launchEffort: "high",
      model: "sonnet", effort: "xhigh", screen: async () => idle, submit };
    const unlock = await tryAcquire(dir);
    expect(await reconcileSeatSettings(settings)).toBe(true);
    await unlock!();
    expect(await reconcileIdleSeat({ stateDir: dir, readCurrent: async () => ({ ...settings }),
      apply: current => reconcileSeatSettings(current) })).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
