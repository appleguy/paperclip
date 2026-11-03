import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createRunBridgeServer, readRunHandle, RUN_BRIDGE_TOOLS } from "./run-bridge.js";

const H = "a".repeat(32);
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const creds = (over = {}) => ({ apiUrl: "http://127.0.0.1:1", apiKey: "k", runId: "r1", agentId: "a1", companyId: "c1", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...over });

describe("run bridge", () => {
  it("reads a valid handle and rejects bad, missing and expired ones", async () => {
    await fs.writeFile(path.join(dir, `${H}.json`), JSON.stringify(creds()));
    await expect(readRunHandle(dir, H)).resolves.toMatchObject({ runId: "r1" });
    await expect(readRunHandle(dir, "../etc/passwd")).rejects.toThrow(/invalid/);
    await expect(readRunHandle(dir, "b".repeat(32))).rejects.toThrow(/unknown or has ended/);
    await fs.writeFile(path.join(dir, `${H}.json`), JSON.stringify(creds({ expiresAt: new Date(Date.now() - 1).toISOString() })));
    await expect(readRunHandle(dir, H)).rejects.toThrow(/expired/);
  });
  it("exposes only the allowlisted tools", () => {
    expect(createRunBridgeServer(dir).toolNames.sort()).toEqual([...RUN_BRIDGE_TOOLS].sort());
  });
});
