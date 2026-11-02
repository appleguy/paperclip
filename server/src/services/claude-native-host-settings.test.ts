import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveClaudeNativeHostSettings } from "./claude-native-host-settings.js";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "claude-host-settings-")); roots.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("fails closed when Claude is absent, non-executable, a directory or a broken link", async () => {
  const root = fixture();
  vi.stubEnv("PATH", root); vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Native Claude CLI is unavailable");
  const cli = join(root, "claude");
  writeFileSync(cli, "fixture", { mode: 0o600 });
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Native Claude CLI is unavailable");
  rmSync(cli); mkdirSync(cli);
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Native Claude CLI is unavailable");
  rmSync(cli, { recursive: true }); symlinkSync(join(root, "missing"), cli);
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Native Claude CLI is unavailable");
});

it("uses absolute host PATH and validates executable symlink targets", async () => {
  const root = fixture(); const target = join(root, "target");
  writeFileSync(target, "fixture", { mode: 0o700 });
  symlinkSync(target, join(root, "claude"));
  vi.stubEnv("PATH", `relative:${root}`); vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "config"));
  expect(await resolveClaudeNativeHostSettings()).toEqual({ claudeExecutable: join(root, "claude"),
    home: homedir(), claudeConfigDir: join(root, "config") });
  chmodSync(target, 0o600);
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Native Claude CLI is unavailable");
});

it("rejects relative server configuration and ignores client-supplied arguments", async () => {
  const root = fixture(); writeFileSync(join(root, "claude"), "fixture", { mode: 0o700 });
  vi.stubEnv("PATH", root); vi.stubEnv("CLAUDE_CONFIG_DIR", "relative/config");
  await expect(resolveClaudeNativeHostSettings()).rejects.toThrow("Invalid Claude host configuration");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  const result = await (resolveClaudeNativeHostSettings as (...args: unknown[]) => ReturnType<typeof resolveClaudeNativeHostSettings>)({
    claudeExecutable: "/client/claude", home: "/client", claudeConfigDir: "/client/config",
  });
  expect(result).toEqual({ claudeExecutable: join(root, "claude"), home: homedir() });
});
