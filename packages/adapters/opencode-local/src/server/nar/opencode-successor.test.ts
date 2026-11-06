import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeHttpDriver } from "./opencode-http-driver.js";

describe("recovered OpenCode turn history", () => {
  it.each([
    { messages: [{ id: "assistant", type: "assistant" }, { id: "target", type: "user" }], successor: false },
    { messages: [{ id: "later", type: "user" }, { id: "target", type: "user" }], successor: true },
  ])("detects a newer user turn", async ({ messages, successor }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-history-"));
    try {
      const passwordFile = path.join(dir, "password");
      await writeFile(passwordFile, "fixture");
      const driver = new OpenCodeHttpDriver({ url: "http://127.0.0.1:4096", passwordFile,
        fetchImpl: (async () => Response.json({ data: messages })) as typeof fetch });
      expect(await driver.hasSuccessor("session", "target")).toBe(successor);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not infer an uncontended outcome when the target is absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-history-"));
    try {
      const passwordFile = path.join(dir, "password");
      await writeFile(passwordFile, "fixture");
      const driver = new OpenCodeHttpDriver({ url: "http://127.0.0.1:4096", passwordFile,
        fetchImpl: (async () => Response.json({ data: [] })) as typeof fetch });
      await expect(driver.hasSuccessor("session", "target")).rejects.toThrow("not found");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
