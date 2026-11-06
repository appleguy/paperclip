import { describe, expect, it } from "vitest";
import { deriveRcName, reportsToDepth, sanitizeRcName } from "./rc-name.js";

const agents = [
  { id: "b", name: "Board", reportsTo: null },
  { id: "p", name: "Platform Lead", reportsTo: "b" },
  { id: "w", name: "Claude Worker 4 (Sonnet RC)", reportsTo: "p" },
  { id: "x", name: "Loop X", reportsTo: "y" },
  { id: "y", name: "Loop Y", reportsTo: "x" },
  { id: "o", name: "Orphan", reportsTo: "gone" },
];

describe("claude_rc Remote Control name", () => {
  it("prefixes actual model and effort without duplicating the family", () => {
    expect(deriveRcName("Sonnet Worker High", 2, 1, "claude-sonnet-5-5", "high")).toBe("S@H 2 Worker s1");
    expect(deriveRcName("Opus Worker", 1, 0, "unknown", "max")).toBe("Mx 1 Opus Worker");
    expect(deriveRcName("Opus Worker", 1, 0, "claude-opus-5-5", null)).toBe("O 1 Worker");
  });
  it("counts reportsTo hops below Board", () => {
    expect(reportsToDepth("b", agents)).toBe(0);
    expect(reportsToDepth("p", agents)).toBe(1);
    expect(reportsToDepth("w", agents)).toBe(2);
    expect(reportsToDepth("nope", agents)).toBe(0);
  });
  it("survives cycles and dangling parents", () => {
    expect(reportsToDepth("x", agents)).toBe(2);
    expect(reportsToDepth("o", agents)).toBe(1);
  });
  it("derives '<depth> <name>' and strips disallowed characters", () => {
    expect(deriveRcName("Board", 0)).toBe("0 Board");
    expect(deriveRcName("Platform Lead", 1)).toBe("1 Platform Lead");
    expect(deriveRcName("Claude Worker 4 (Sonnet RC)", 2)).toBe("2 Claude Worker 4 Sonnet RC");
    expect(deriveRcName("Lead * (Opus)", 1)).toBe("1 Lead Opus");
  });
  it("caps at 60 chars and never yields an empty or invalid name", () => {
    const long = deriveRcName("A".repeat(100), 3);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.startsWith("3 AAA")).toBe(true);
    expect(sanitizeRcName("***")).toBe("Paperclip Claude");
    expect(sanitizeRcName("")).toBe("Paperclip Claude");
    expect(deriveRcName("x", -1)).toBe("0 x");
    expect(deriveRcName("x", NaN)).toBe("0 x");
    for (const n of [deriveRcName("é ñ 日本", 1), deriveRcName("a/b\\c;`$(x)", 2)])
      expect(n).toMatch(/^[A-Za-z0-9 ._-]{1,60}$/);
  });
});
