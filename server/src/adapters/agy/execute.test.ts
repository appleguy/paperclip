import { describe, expect, it } from "vitest";
import { adoptableActive, isIdleScreen, normalizeOneLine, parseReceipt, parseRemoteUrl, parseRemoteConversationId, pasteSettleMs } from "./execute.js";

describe("agy single-RC dispatch safety", () => {
  it("parses shared /r/ base URL and drops conversation query", () => {
    expect(parseRemoteUrl("Open https://antigravity.google.com/r/abc-123-v2?p=c%2Ftopic")).toBe(
      "https://antigravity.google.com/r/abc-123-v2",
    );
    expect(parseRemoteUrl("not connected")).toBeNull();
  });

  it("reads the live /remote-control conversation even before cache updates", () => {
    const screen = "p=c%2F11111111-1111-4111-8111-111111111111\\n" +
      "> /new\\n> /remote-control\\n" +
      "https://antigravity.google.com/r/fake-v2?\\n" +
      "p=c%2F22222222-2222-4222-8222-222222222222";
    expect(parseRemoteConversationId(screen)).toBe("22222222-2222-4222-8222-222222222222");
    expect(parseRemoteConversationId("no active RC")).toBeNull();
  });

  it("forbids newline submissions that send early TUI turns", () => {
    expect(normalizeOneLine("first line\nsecond line\tthird")).toBe("first line second line third");
  });

  it("delays Enter to let long pasted prompts settle in the agy editor", () => {
    expect(pasteSettleMs(10)).toBe(800);
    expect(pasteSettleMs(12000)).toBe(2900);
    expect(pasteSettleMs(20000)).toBe(3000);
  });

  it("recognizes idle vs generating TUI screens", () => {
    expect(isIdleScreen([
      "Gemini 3.8 Flash", "─────────────────", ">", "─────────────────",
      "? for shortcuts                 Gemini 3.8 Flash · low",
    ].join("\n"))).toBe(true);
    expect(isIdleScreen([
      "Generating...", "─────────────────", "> message", "─────────────────",
      "esc to cancel                  Gemini 3.8 Flash · low",
    ].join("\n"))).toBe(false);
  });

  it("accepts only an issue-scoped 250-character completion with exact IDs", () => {
    const r = JSON.stringify({
      runId: "r1", issueId: "i1", status: "done", summary: "finished the small task",
      report: "x".repeat(260),
    });
    expect(parseReceipt(r, "r1", "i1").summary).toBe("finished the small task");
    expect(() => parseReceipt(r, "r2", "i1")).toThrow(/exact run/);
    expect(() => parseReceipt(r, "r1", "i2")).toThrow(/exact run/);
    expect(() => parseReceipt(JSON.stringify({ ...JSON.parse(r), report: "short" }), "r1", "i1")).toThrow(/250/);
    expect(() => parseReceipt(JSON.stringify({ ...JSON.parse(r), status: "blocked" }), "r1", "i1")).toThrow(/done/);
  });
  it("adopts only the same issue's checkpoint after a crash, never another issue's", () => {
    const run = "8e5cbb55-1e72-4dda-a4f5-f0b050c2ee6c";
    const a = { runId: run, issueId: "i1", receiptPath: `/s/receipt-${run}.json`, rcUrl: "https://antigravity.google.com/r/x", conversationId: "c1" };
    expect(adoptableActive("", "i1", "/s")).toBeNull();
    expect(adoptableActive(JSON.stringify(a), "i1", "/s")?.runId).toBe(run);
    expect(() => adoptableActive(JSON.stringify(a), "i2", "/s")).toThrow(/Never replay/);
    expect(() => adoptableActive(JSON.stringify({ ...a, receiptPath: "/etc/x.json" }), "i1", "/s")).toThrow(/Never replay/);
    expect(() => adoptableActive("{not json", "i1", "/s")).toThrow(/Never replay/);
  });
});
