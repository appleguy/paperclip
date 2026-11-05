import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatGptWebDriver, DISPATCH_ARGV, WebDriverRefused, webConversationId, type WebExec } from "./chatgpt-web-driver.js";

const F = { runId: "r1", leaseGeneration: 1, hostEpoch: 1 };
function mk(exit: number | null = 0) {
  const dir = mkdtempSync(join(tmpdir(), "nar-web-"));
  const bin = join(dir, "dispatch");
  writeFileSync(bin, "");
  const calls: { file: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const exec: WebExec = async (file, args, env) => (calls.push({ file, args, env }), { exitCode: exit });
  const d = new ChatGptWebDriver({ dispatchBin: bin, receiptDir: join(dir, "rc"), exec, env: { PATH: "/bin", PAPERCLIP_RUN_ID: "x", SECRET_OTHER: "no", LD_PRELOAD: "evil" } });
  return { d, calls, bin };
}
const op = (opId = "op1", kind: "prompt" | "interrupt" = "prompt") => ({ opId, kind, payloadSha256: "h", text: "t" });

describe("ChatGptWebDriver", () => {
  it("runs only the fixed argv with an allowlisted env and writes a durable receipt", async () => {
    const { d, calls, bin } = mk();
    const h = await d.attestHost("a");
    const b = await d.bindConversation(h, { agentId: "a", issueId: "i", cwd: "/" }, "new", F);
    expect(b.conversationId).toBe(webConversationId("a", "i"));
    const r = await d.submit(h, b.conversationId, op(), F);
    expect(r.grade).toBe("emitted_local");
    expect(calls).toEqual([{ file: bin, args: DISPATCH_ARGV, env: { PATH: "/bin", PAPERCLIP_RUN_ID: "x" } }]);
    expect(await d.readOutcome(b.conversationId, "op1")).toBe("receipted");
  });
  it("fails closed: unsupported op, host creation, bad resume id, unsafe opId", async () => {
    const { d, calls } = mk();
    const h = await d.attestHost("a");
    await expect(d.submit(h, "c", op("op2", "interrupt"), F)).rejects.toThrow(WebDriverRefused);
    await expect(d.attestHost("a", { create: true })).rejects.toThrow(WebDriverRefused);
    await expect(d.bindConversation(h, { agentId: "a", issueId: "i", cwd: "/" }, "resume", F, "web-other")).rejects.toThrow(WebDriverRefused);
    await expect(d.submit(h, "c", op("../x"), F)).rejects.toThrow(WebDriverRefused);
    await expect(d.submit({ ...h, provider: "codex" }, "c", op("op3"), F)).rejects.toThrow(WebDriverRefused);
    expect(calls).toHaveLength(0);
  });
  it("never resubmits an op and never claims delivery for failed exits", async () => {
    const { d, calls } = mk(1);
    const h = await d.attestHost("a");
    const r = await d.submit(h, "c", op("op4"), F);
    expect(r.grade).toBe("outcome_unknown");
    expect(await d.readOutcome("c", "op4")).toBe("unknown");
    await expect(d.submit(h, "c", op("op4"), F)).rejects.toThrow(/not retrying/);
    expect(calls).toHaveLength(1);
  });
  it("reattaches across driver instances via the receipt dir", async () => {
    const { d, bin } = mk();
    const h = await d.attestHost("a");
    await d.submit(h, "c", op("op5"), F);
    const d2 = new ChatGptWebDriver({ dispatchBin: bin, receiptDir: (d as any).o.receiptDir, exec: async () => ({ exitCode: 0 }), env: {} });
    expect(await d2.readOutcome("c", "op5")).toBe("receipted");
    expect(await d2.readOutcome("c", "nope")).toBe("unknown");
  });
});
