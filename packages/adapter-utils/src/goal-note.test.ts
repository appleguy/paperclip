import { describe, expect, it } from "vitest";
import { renderPaperclipGoalNote, selectPaperclipPromptSections } from "./server-utils.js";

// SCO-756: managed session goal in the prompt; a kept conversation gets it once, then only on change.
describe("renderPaperclipGoalNote", () => {
  const active = { state: "active", objective: "Keep the board moving", key: "active:aaa" };
  it("renders an active goal on a fresh session", () => {
    expect(renderPaperclipGoalNote(active)).toContain("Keep the board moving");
    expect(renderPaperclipGoalNote({ objective: "legacy shape" })).toContain("legacy shape");
  });
  it("skips an unchanged goal on a resumed session and resends a changed one", () => {
    expect(renderPaperclipGoalNote({ ...active, deliveredKey: "active:aaa" }, { resumedSession: true })).toBe("");
    expect(renderPaperclipGoalNote({ ...active, deliveredKey: "active:old" }, { resumedSession: true })).toContain("Keep the board moving");
    expect(renderPaperclipGoalNote({ ...active, deliveredKey: null }, { resumedSession: true })).toContain("Keep the board moving");
  });
  it("tells a resumed conversation once that a goal it saw was paused or cleared", () => {
    expect(renderPaperclipGoalNote({ state: "paused", objective: "x", key: "paused:b", deliveredKey: "active:aaa" }, { resumedSession: true })).toMatch(/paused/);
    expect(renderPaperclipGoalNote({ state: "cleared", objective: null, key: "cleared", deliveredKey: "active:aaa" }, { resumedSession: true })).toMatch(/cleared/);
    expect(renderPaperclipGoalNote({ state: "cleared", objective: null, key: "cleared", deliveredKey: "cleared" }, { resumedSession: true })).toBe("");
    expect(renderPaperclipGoalNote({ state: "paused", objective: "x", key: "paused:b" })).toBe("");
    expect(renderPaperclipGoalNote({ state: "cleared", objective: null, key: "cleared", deliveredKey: null }, { resumedSession: true })).toBe("");
  });
  it("rides in the wake prompt of selectPaperclipPromptSections", () => {
    const { wakePrompt } = selectPaperclipPromptSections({ paperclipRunnerGoal: active });
    expect(wakePrompt).toContain("Standing goal for this issue");
  });
});
