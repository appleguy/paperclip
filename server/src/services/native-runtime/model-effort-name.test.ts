import { describe, expect, it } from "vitest";
import { modelEffortName } from "./model-effort-name.js";

describe("modelEffortName", () => {
  it("maps actual families and effort, omitting unknown halves", () => {
    for (const [harness, model, effort, expected] of [
      ["codex", "gpt-6-sol", "low", "S@L"], ["codex", "gpt-6.1-terra", "xhigh", "T@X"],
      ["codex", "gpt-6-luna", "medium", "L@M"], ["codex", "gpt-6-astra", "max", "A@Mx"],
      ["claude", "claude-opus-5-5", "high", "O@H"], ["claude", "haiku", "low", "H@L"],
      ["claude", "fable", "medium", "F@M"], ["agy", "gemini-3.8-flash", "high", "GF@H"],
      ["agy", "gemini-4-argon", "low", "Ar@L"], ["agy", "claude-opus-5-5", "max", "O@Mx"],
      ["agy", "unknown", "high", "H"], ["agy", "flash", "unknown", "GF"], ["agy", "unknown", "unknown", ""],
    ] as const) expect(modelEffortName(harness, model, effort)).toBe(expected);
  });
});
