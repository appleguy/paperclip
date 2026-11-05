import { describe, expect, it } from "vitest";
import { assembleDispatchPrompt, dispatchInstructionsPrefix, fitPromptSections, PROMPT_BUDGET } from "./execute.js";
import { routeChannelInput, type ChannelIO } from "./channel.js";

const join = (s: string[]) => s.filter(Boolean).join("\n\n");

describe("claude-rc prompt budget", () => {
  it("keeps fresh run rules before issue data and omits them on a known conversation", async () => {
    const prefix = dispatchInstructionsPrefix("AGENT RULES", false);
    expect(prefix).toContain("never background a tool call");
    expect(prefix).toContain("Do not write a done receipt on failure");
    expect(dispatchInstructionsPrefix("AGENT RULES", true)).toBe("");
    const first = await assembleDispatchPrompt([prefix, "intro", "issue A", "wake A", "", "receipt A"], "test-seat", "claude-haiku-5-5");
    const second = await assembleDispatchPrompt([prefix, "intro", "issue B", "wake B", "", "receipt B"], "test-seat", "claude-haiku-5-5");
    expect(first.startsWith(prefix)).toBe(true);
    expect(second.startsWith(prefix)).toBe(true);
    expect(first.indexOf("issue A")).toBeGreaterThan(prefix.length);
  });
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

  it("dispatches an oversized wake through the channel after assembly and token preflight", async () => {
    let delivered = "";
    const io: ChannelIO = {
      ready: async () => true,
      status: async () => delivered ? {
        op_id: "budget-wake", stage: "hook_observed", hook_observed: true,
        held_unknown_effect: false, receipt: null,
      } : null,
      submit: async (_id, content) => { delivered = content; return { ok: true }; },
      fallback: async () => { throw new Error("unexpected fallback"); },
    };
    const sections = ["RUN RULES", "intro", "C".repeat(40_000),
      "W".repeat(80_000) + "LATEST OWNER DIRECTION", "ROTATION HANDOFF", "RECEIPT RULES"];
    const prompt = await assembleDispatchPrompt(sections, "test-seat", "claude-haiku-5-5");
    await expect(routeChannelInput("budget-wake", prompt, false, io)).resolves.toBe("channel");
    expect(delivered.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    for (const text of ["RUN RULES", "LATEST OWNER DIRECTION", "ROTATION HANDOFF", "RECEIPT RULES",
      "fetch the issue thread and documents"]) expect(delivered).toContain(text);
  });

  it("still refuses a trimmed prompt exceeding the configured token allowance", async () => {
    await expect(assembleDispatchPrompt(["rules", "intro", "ctx", "W".repeat(80_000), "", "receipt"],
      "test-seat", "claude-haiku-5-5", 0.1)).rejects.toThrow(/Token preflight refused/);
  });

  it("still refuses oversized sections that are not safe to trim", async () => {
    await expect(assembleDispatchPrompt(["R".repeat(60_000), "intro", "ctx", "wake", "", "receipt"],
      "test-seat", "claude-sonnet-5-5")).rejects.toThrow(/exceeds dispatch budget/);
  });
});
