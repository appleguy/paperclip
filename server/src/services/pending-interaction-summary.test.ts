import { describe, expect, it } from "vitest";
import { pendingInteractionSummary } from "./pending-interaction-summary.js";

describe("pending interaction summaries", () => {
  it("summarizes the card's questions and bounds their length", () => {
    expect(pendingInteractionSummary({ questions: [{ prompt: "Which\n scope?" }, { prompt: "When?" }] }))
      .toBe("Which scope?; When?");
    expect(pendingInteractionSummary({ questions: [{ prompt: "x".repeat(600) }] })).toHaveLength(500);
  });

  it("handles missing or malformed question content", () => {
    expect(pendingInteractionSummary(null)).toBe("Question details are available on the card.");
    expect(pendingInteractionSummary({ questions: [null, { prompt: " " }] })).toBe("Question details are available on the card.");
  });
});
