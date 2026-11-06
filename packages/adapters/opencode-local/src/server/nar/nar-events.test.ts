import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({ inflight: null as string | null }));
vi.mock("./opencode-http-driver.js", async (orig) => {
  const real = await orig<typeof import("./opencode-http-driver.js")>();
  class FakeDriver {
    async attestHost() { return { hostEpoch: 1, detail: { pid: 7 } }; }
    async latestGeneration() { return -1; }
    async bindConversation() { return { conversationId: "ses_test" }; }
    async inflightMessage() { return driver.inflight; }
    async submit() { return { grade: "outcome_unknown", evidence: "test" }; }
    async readOutcomeMsg() { return "hook_observed"; }
    async interruptExpectedMessage() { return "idle"; }
    async probePid() { return 7; }
  }
  return { ...real, OpenCodeHttpDriver: FakeDriver };
});
import { narEventLine, runNarOpenCodeAttempt } from "./nar-attempt.js";

async function run(prompt: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nar-ev-"));
  const configPath = path.join(dir, "opencode.json");
  await fs.writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:4096" }));
  const out: string[] = [];
  await runNarOpenCodeAttempt({
    configPath, agentId: "a", taskId: "t", runId: "run-1", cwd: dir, model: "", prompt, timeoutSec: 5, pollMs: 1,
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    onLog: async (_s, c) => { out.push(c); },
  });
  await fs.rm(dir, { recursive: true });
  return out.flatMap((c) => c.split("\n")).filter((l) => l.startsWith("[paperclip:event] ")).map((l) => JSON.parse(l.slice(18)));
}

describe("NAR structured telemetry events", () => {
  beforeEach(() => { driver.inflight = null; });

  it("formats a single parseable line", () => {
    const line = narEventLine("nar_rejoin", { sessionId: "s", messageId: "m" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.slice(18))).toEqual({ event: "nar_rejoin", sessionId: "s", messageId: "m" });
  });

  it("emits nar_prompt_dispatch (and no rejoin) when the prompt is sent", async () => {
    const events = await run("hello");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "nar_prompt_dispatch", sessionId: "ses_test",
      promptSha256: createHash("sha256").update("hello").digest("hex"),
    });
    expect(events[0].clientMessageId).toEqual(expect.any(String));
  });

  it("emits nar_rejoin (and no dispatch) when an in-flight message is adopted", async () => {
    driver.inflight = "msg_old";
    const events = await run("hello");
    expect(events).toEqual([{ event: "nar_rejoin", sessionId: "ses_test", messageId: "msg_old" }]);
  });
});
