import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  HOMEBREW_OPENCODE_COMMAND,
  resolvePinnedOpenCodeCommand,
} from "./opencode-server-driver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function executable(contents = "#!/bin/sh\nexit 0\n") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "paperclip-opencode-command-")),
  );
  roots.push(root);
  const path = join(root, "opencode");
  await writeFile(path, contents, { mode: 0o755 });
  return path;
}

it("binds the Homebrew executable and accepts every 2.x version probe", async () => {
  expect(HOMEBREW_OPENCODE_COMMAND).toBe("/opt/homebrew/bin/opencode");
  const command = await executable();
  expect(
    resolvePinnedOpenCodeCommand({
      command,
      probeVersion: () => "opencode v2.2.5\n",
    }),
  ).toBe(command);
  expect(
    resolvePinnedOpenCodeCommand({
      command,
      probeVersion: () => "opencode v2.3.1\n",
    }),
  ).toBe(command);
});

it("fails closed on a 1.x version probe", async () => {
  const command = await executable();
  expect(() =>
    resolvePinnedOpenCodeCommand({
      command,
      probeVersion: () => "opencode v1.18.34\n",
    }),
  ).toThrow("not a qualified 2.x runtime");
});

it("fails closed when the executable or its version is missing", async () => {
  const missing = join(tmpdir(), `paperclip-opencode-missing-${process.pid}`);
  expect(() =>
    resolvePinnedOpenCodeCommand({
      command: missing,
      probeVersion: () => "opencode v2.2.5\n",
    }),
  ).toThrow("Pinned OpenCode runtime unavailable");

  const command = await executable();
  expect(() =>
    resolvePinnedOpenCodeCommand({ command, probeVersion: () => "" }),
  ).toThrow("did not report a semantic version");

  await chmod(command, 0o644);
  expect(() =>
    resolvePinnedOpenCodeCommand({
      command,
      probeVersion: () => "opencode v2.2.5\n",
    }),
  ).toThrow("Pinned OpenCode runtime unavailable");
});
