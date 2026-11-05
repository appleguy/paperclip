import { describe, expect, it } from "vitest";
import { fitPromptSections, PROMPT_BUDGET } from "./execute.js";

const join = (s: string[]) => s.filter(Boolean).join("\n\n");

describe("claude-rc prompt budget", () => {
  it("leaves a prompt under budget untouched", () => {
    const s = ["rules", "intro", "ctx", "wake", "do it"];
    expect(fitPromptSections(s, [2, 3], join)).toEqual(s);
  });

  it("trims the oversized wake history and keeps the run rules intact", () => {
    const s = ["rules", "intro", "ctx", "W".repeat(80_000) + "TAIL", "RECEIPT RULES"];
    const out = fitPromptSections(s, [2, 3], join);
    expect(join(out).length).toBeLessThanOrEqual(PROMPT_BUDGET);
    expect(out[4]).toBe("RECEIPT RULES");
    expect(out[3]).toContain("omitted to fit the dispatch budget");
    expect(out[3].endsWith("TAIL")).toBe(true);
  });

  it("trims both sections when each is large", () => {
    const s = ["", "", "C".repeat(40_000), "W".repeat(40_000), "end"];
    expect(join(fitPromptSections(s, [2, 3], join)).length).toBeLessThanOrEqual(PROMPT_BUDGET);
  });
});
