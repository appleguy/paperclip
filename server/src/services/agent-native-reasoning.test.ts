import { describe, expect, it } from "vitest";
import { openCodeSessionIdFromRunLog, readNativeReasoning } from "./agent-native-reasoning.js";

describe("native OpenCode reasoning", () => {
  it("derives only a well-formed session from the Paperclip-owned run log", () => {
    const session = "ses_e715d20ddffeYgwzjgNO8pkMmC";
    const sample = JSON.stringify({ ts: "now", stream: "stdout", chunk: JSON.stringify({ type: "step_start", sessionID: session }) }) + "\n";
    expect(openCodeSessionIdFromRunLog(sample)).toBe(session);
    expect(openCodeSessionIdFromRunLog("bad\n" + sample)).toBe(session);
    expect(openCodeSessionIdFromRunLog(JSON.stringify({ chunk: JSON.stringify({ sessionID: "../secrets" }) }) + "\n")).toBeNull();
  });
  it("refuses arbitrary model paths or untrusted session IDs before reading disk", () => {
    expect(readNativeReasoning("/tmp/arbitrary.db", "ses_abcdefghijkl", "2026-10-31T06:00:00Z")).toMatchObject({ available: false, parts: [] });
    expect(readNativeReasoning("native-fleet/wrx80/glm-5.3-flash-colibri", "../bad", "2026-10-31T06:00:00Z")).toMatchObject({ available: false, parts: [] });
    expect(readNativeReasoning("native-fleet/wrx80/glm-5.3-flash-colibri", "ses_e715d20ddffeYgwzjgNO8pkMmC")).toMatchObject({ available: false, parts: [] });
  });
});
