import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listServerAdapters } from "../registry.js";
import { validateConfig, withConfigValidation } from "./index.js";

const adapters = listServerAdapters();
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(process.env.PAPERCLIP_TMPDIR || os.tmpdir(), "save-config-"));
  await writeFile(path.join(directory, "file"), "fixture");
});

describe.each(adapters)("$type save-time validation", adapter => {
  it("exports a validator and accepts valid configuration", async () => {
    expect(adapter.validateConfig).toBeTypeOf("function");
    await expect(adapter.validateConfig!({ cwd: process.cwd(), timeoutSec: 60 })).resolves.toBeUndefined();
  });

  it("rejects an invalid model", async () => {
    await expect(adapter.validateConfig!({ model: "-invalid-model" })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an invalid effort", async () => {
    await expect(adapter.validateConfig!({ effort: "impossible" })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a missing cwd and a file used as cwd", async () => {
    for (const cwd of [path.join(directory, "missing"), path.join(directory, "file"), "relative", ""]) {
      await expect(adapter.validateConfig!({ cwd })).rejects.toMatchObject({ status: 422 });
    }
  });

  it("rejects invalid timeout values", async () => {
    for (const timeoutSec of [-1, NaN, Infinity, "60", 2 ** 31]) {
      await expect(adapter.validateConfig!({ timeoutSec })).rejects.toMatchObject({ status: 422 });
    }
  });
});

it("uses the same RC allowlists as execution, including Opus", async () => {
  await expect(validateConfig("claude_rc_local", { model: "claude-opus-5-5", effort: "max" })).resolves.toBeUndefined();
  await expect(validateConfig("claude_rc_local", { model: "claude-fable-5" })).rejects.toThrow(/model/);
  await expect(validateConfig("claude_rc_local", { effort: "ultra" })).rejects.toThrow(/effort/);
  await expect(validateConfig("claude_rc_local", { cwd: "/Volumes/NVM/../.." })).rejects.toThrow(/root/);
});

it("rejects models outside agy's allowlist and separate effort settings", async () => {
  await expect(validateConfig("agy_local", { model: "gemini-4-argon-high" })).resolves.toBeUndefined();
  await expect(validateConfig("agy_local", { model: "gpt-6.1-sol" })).rejects.toThrow(/model/);
  await expect(validateConfig("agy_local", { effort: "high" })).rejects.toThrow(/model id/);
  await expect(validateConfig("agy_local", { cwd: "/Volumes/NVM/../.." })).rejects.toThrow(/root/);
});

describe.each(["claude_rc_local", "agy_local"])("%s tmux names", type => {
  it.each(["tmuxSocket", "tmuxSession"])("rejects invalid %s identifiers", async field => {
    for (const value of ["bad/socket", "bad.socket", "bad:session", "two words", "bad\nname", "x".repeat(56), 42, {}]) {
      await expect(validateConfig(type, { [field]: value })).rejects.toMatchObject({ status: 422, message: expect.stringContaining(field) });
    }
  });

  it("accepts defaults and the runtime's trimmed names", async () => {
    for (const value of [undefined, null, "", "   ", "valid_1-name", "  trimmed-name  ", "x".repeat(55)]) {
      await expect(validateConfig(type, { tmuxSocket: value, tmuxSession: value })).resolves.toBeUndefined();
    }
  });
});

it("validates the generated RC session names for the configured seat count", async () => {
  await expect(validateConfig("claude_rc_local", { tmuxSession: "x".repeat(52), slots: 4 })).resolves.toBeUndefined();
  await expect(validateConfig("claude_rc_local", { tmuxSession: "x".repeat(53), slots: 2 })).rejects.toThrow(/seat suffix/);
  await expect(validateConfig("claude_rc_local", { tmuxSession: "x".repeat(55), slots: 1 })).resolves.toBeUndefined();
});

it("checks all effort field aliases and model-specific effort limits", async () => {
  await expect(validateConfig("codex_local", { model: "gpt-6.1-sol", modelReasoningEffort: "ultra" })).resolves.toBeUndefined();
  await expect(validateConfig("codex_local", { model: "gpt-6-luna", modelReasoningEffort: "ultra" })).rejects.toThrow(/modelReasoningEffort/);
  await expect(validateConfig("claude_local", { model: "claude-opus-5-5", effort: "max" })).resolves.toBeUndefined();
  await expect(validateConfig("grok_local", { model: "grok-4.7", reasoningEffort: "xhigh" })).resolves.toBeUndefined();
  await expect(validateConfig("grok_local", { reasoningEffort: "max" })).rejects.toThrow(/reasoningEffort/);
});

it("preserves zero as unlimited outside RC and enforces RC's actual timeout range", async () => {
  await expect(validateConfig("process", { timeoutSec: 0 })).resolves.toBeUndefined();
  for (const type of ["agy_local", "claude_rc_local"]) {
    for (const timeoutSec of [30, 3600]) await expect(validateConfig(type, { timeoutSec })).resolves.toBeUndefined();
    for (const timeoutSec of [0, 29, 3601]) await expect(validateConfig(type, { timeoutSec })).rejects.toThrow(/timeoutSec/);
  }
  await expect(validateConfig("http", { timeoutMs: 2 ** 31 })).rejects.toThrow(/timeoutMs/);
});

it("retains an external adapter's validator and module identity", async () => {
  const providerValidation = vi.fn();
  const adapter = { type: "external", execute: vi.fn(), testEnvironment: vi.fn(), validateConfig: providerValidation };
  expect(withConfigValidation(adapter)).toBe(adapter);
  expect(withConfigValidation(adapter)).toBe(adapter);
  await adapter.validateConfig({ model: "custom/provider-model" });
  expect(providerValidation).toHaveBeenCalledOnce();
});

it("returns a precise 4xx when a plugin rejects its configuration", async () => {
  const adapter = withConfigValidation({ type: "plugin", execute: vi.fn(), testEnvironment: vi.fn(),
    validateConfig: () => { throw new Error("model is not enabled for this endpoint"); } });
  await expect(adapter.validateConfig!({})).rejects.toMatchObject({ status: 422, message: expect.stringContaining("model is not enabled") });
});

it("does not inspect a remote environment's cwd on the API host", async () => {
  await expect(validateConfig("codex_local", { cwd: "/remote/agent" }, { localCwd: false })).resolves.toBeUndefined();
  await expect(validateConfig("codex_local", { cwd: "E:\\agent" }, { localCwd: false })).resolves.toBeUndefined();
  await expect(validateConfig("codex_local", { cwd: "relative" }, { localCwd: false })).rejects.toThrow(/cwd/);
});
