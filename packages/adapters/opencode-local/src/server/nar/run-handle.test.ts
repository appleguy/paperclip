import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runHandleDir, runHandleNote, writeRunHandle } from "./run-handle.js";

describe("run handle", () => {
  it("writes a private per-wake credential file and removes it on cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rh-"));
    const configPath = path.join(root, "opencode.json");
    const { handle, cleanup } = await writeRunHandle({ configPath, apiUrl: "http://x", apiKey: "SECRET-XYZ", runId: "r", agentId: "a", companyId: "c", ttlMs: 1000 });
    expect(handle).toMatch(/^[a-f0-9]{32}$/);
    const file = path.join(runHandleDir(configPath), `${handle}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(runHandleDir(configPath))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await fs.readFile(file, "utf8")).runId).toBe("r");
    expect(runHandleNote(handle)).not.toContain("SECRET-XYZ");
    await cleanup();
    await expect(fs.stat(file)).rejects.toThrow();
    await fs.rm(root, { recursive: true });
  });
});
