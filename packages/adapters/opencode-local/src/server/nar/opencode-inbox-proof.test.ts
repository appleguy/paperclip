import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeHttpDriver } from "./opencode-http-driver.js";

describe("OpenCode inbox evidence", () => {
  it.each([
    [503, { error: "unavailable" }],
    [200, { data: null }],
    [200, { data: [{}] }],
  ])("does not treat an unreadable inbox as idle (HTTP %s)", async (status, body) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-inbox-proof-"));
    try {
      const passwordFile = path.join(dir, "password");
      await writeFile(passwordFile, "fixture");
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
      const driver = new OpenCodeHttpDriver({ url: "http://127.0.0.1:4096", passwordFile, fetchImpl });
      await expect(driver.inflightMessage("ses_fixture")).rejects.toThrow(/session\.inbox/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
