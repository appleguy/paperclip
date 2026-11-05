import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSeatLaunch, reconcileSeatSettings } from "./execute.js";

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
});
