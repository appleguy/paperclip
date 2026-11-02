import { describe, expect, it } from "vitest";
import { isIdleScreen, normalizeOneLine, parseReceipt, parseRemoteUrl } from "./execute.js";

describe("agy single-RC dispatch safety", () => {
  it("parses shared /r/ base URL and drops conversation query", () => {
    expect(parseRemoteUrl("Open https://antigravity.google.com/r/abc-123-v2?p=c%2Ftopic")).toBe(
      "https://antigravity.google.com/r/abc-123-v2",
    );
    expect(parseRemoteUrl("not connected")).toBeNull();
  });

  it("forbids newline submissions that send early TUI turns", () => {
    expect(normalizeOneLine("first line\nsecond line\tthird")).toBe("first line second line third");
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
});
