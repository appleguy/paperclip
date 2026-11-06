import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SCO-756: a rejoined in-flight message that makes no progress must not hold the run open forever.
const d = vi.hoisted(() => ({ inflight: "msg_old" as string | null, marks: [] as (string | null)[], interrupts: 0, settleAfter: Infinity, reads: 0, successorAfter: Infinity, interruptResult: "requested" as "requested" | "uncertain", verified: false, checks: 0, pidAfterStop: 7 }));
vi.mock("./opencode-http-driver.js", async (orig) => {
  const real = await orig<typeof import("./opencode-http-driver.js")>();
  class FakeDriver {
    async attestHost() { return { hostEpoch: 1, detail: { pid: 7 } }; }
    async latestGeneration() { return 0; }
    async bindConversation() { return { conversationId: "ses_test" }; }
    async messageExists() { return false; }
    async inflightMessage() { return d.reads >= d.successorAfter ? "msg_successor" : d.inflight; }
    async submit() { throw new Error("must not resend on rejoin"); }
    async readOutcomeMsg() { return ++d.reads >= d.settleAfter ? "hook_observed" : "working"; }
    async progressMark() { return d.marks.length > 1 ? d.marks.shift()! : d.marks[0] ?? null; }
    async interruptExpectedMessage() { d.interrupts++; d.inflight = null; return d.interruptResult; }
    async verifyStoppedMessage() { d.checks++; return d.verified; }
    async probePid() { return d.interrupts ? d.pidAfterStop : 7; }
  }
  return { ...real, OpenCodeHttpDriver: FakeDriver };
});
import { narOpIdFor, runNarOpenCodeAttempt } from "./nar-attempt.js";
import { messageIdFor } from "./opencode-http-driver.js";

async function run(extra: Record<string, unknown>, onLine?: (line: string) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nar-stall-"));
  const configPath = path.join(dir, "opencode.json");
  await fs.writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:4096", passwordFile: path.join(dir, "pw") }));
  await fs.writeFile(path.join(dir, "pw"), "x");
  const log: string[] = [];
  const res = await runNarOpenCodeAttempt({
    configPath, agentId: "a", taskId: "t", runId: "run-1", cwd: dir, model: "", prompt: "p", timeoutSec: 0,
    pollMs: 1, probeMs: 0, idleGraceMs: 60_000, rejoinStallMs: 40, ...extra,
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    onLog: async (_s, c) => { log.push(c); onLine?.(c); },
  });
  await fs.rm(dir, { recursive: true });
  return { res, log: log.join("") };
}

describe("NAR rejoin stall watchdog", () => {
  beforeEach(() => { Object.assign(d, { inflight: messageIdFor(narOpIdFor("run-1")), marks: ["same"], interrupts: 0, settleAfter: Infinity, reads: 0, successorAfter: Infinity, interruptResult: "requested", verified: false, checks: 0, pidAfterStop: 7 }); });

  it("does not call a different active message an idle session", async () => {
    d.successorAfter = 3;
    d.settleAfter = 8;
    const { res } = await run({ idleGraceMs: 0, rejoinStallMs: 60_000 });
    expect(res.providerTermination).toBeUndefined();
    expect(res.proc.exitCode).toBe(0);
    expect(d.interrupts).toBe(0);
  });

  it("interrupts a rejoined message with no progress and ends the run as interrupted", async () => {
    d.verified = true;
    const { res, log } = await run({});
    expect(d.interrupts).toBe(1);
    expect(res.providerTermination).toEqual({ proof: "session_idle", reason: expect.stringContaining("stalled") });
    expect(log).toContain("made no progress");
  });

  it("holds a stalled turn belonging to another run without interrupting it", async () => {
    d.inflight = messageIdFor(narOpIdFor("other-run"));
    const { res } = await run({});
    expect(d.interrupts).toBe(0);
    expect(d.inflight).toBe(messageIdFor(narOpIdFor("other-run")));
    expect(res.providerTermination).toBeUndefined();
    expect(res.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "unowned_turn_stalled" });
  });

  it("does not accept a foreign turn's settled outcome as the retry's result", async () => {
    d.inflight = messageIdFor(narOpIdFor("other-run"));
    d.settleAfter = 1;
    const { res } = await run({});
    expect(d.interrupts).toBe(0);
    expect(res.proc.exitCode).not.toBe(0);
    expect(res.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "unowned_turn_settled" });
  });

  it("holds an explicit stop of an observed foreign turn without interrupting it", async () => {
    d.inflight = messageIdFor(narOpIdFor("other-run"));
    const controller = new AbortController();
    {
      const { res } = await run({ signal: controller.signal, rejoinStallMs: 60_000 }, line => {
        if (line.includes("nar_rejoin")) setTimeout(() => controller.abort({ code: "paperclip_explicit_run_stop" }), 0);
      });
      expect(d.interrupts).toBe(0);
      expect(d.inflight).toBe(messageIdFor(narOpIdFor("other-run")));
      expect(res.providerTermination).toBeUndefined();
      expect(res.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "unowned_turn" });
    }
  });

  it.each([true, false])("requires target proof after an uncertain interrupt (verified: %s)", async verified => {
    d.interruptResult = "uncertain";
    d.verified = verified;
    d.pidAfterStop = 8;
    const controller = new AbortController();
    const { res } = await run({ signal: controller.signal, rejoinStallMs: 60_000 }, line => {
      if (line.includes("nar_rejoin")) setTimeout(() => controller.abort({ code: "paperclip_explicit_run_stop" }), 0);
    });
    expect(d.interrupts).toBe(1);
    expect(d.checks).toBeGreaterThan(0);
    if (verified) expect(res.providerTermination).toMatchObject({ proof: "session_idle" });
    else {
      expect(res.providerTermination).toBeUndefined();
      expect(res.executionRecovery).toMatchObject({ providerWorkStarted: true, reason: "interrupt_unknown" });
    }
  }, 25_000);

  it("leaves a rejoined message alone while it keeps progressing", async () => {
    d.marks = Array.from({ length: 100000 }, (_, i) => `m${i}`);
    d.settleAfter = 200;
    const { res } = await run({});
    expect(d.interrupts).toBe(0);
    expect(res.providerTermination).toBeUndefined();
    expect(res.proc.exitCode).toBe(0);
  });

  it("never counts an unreadable progress mark as a stall", async () => {
    d.marks = [null];
    d.settleAfter = 200;
    const { res } = await run({});
    expect(d.interrupts).toBe(0);
    expect(res.proc.exitCode).toBe(0);
  });
});
