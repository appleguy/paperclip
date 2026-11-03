import { describe, expect, it } from "vitest";
import { isClaudeIdle, parseClaudeRcUrl, projectDir } from "./execute.js";

const rule = "─".repeat(40) + " Paperclip Claude ─";
const footer = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("claude_rc_local screen parsing", () => {
  it("treats the empty input box with the permission footer as idle", () => {
    expect(isClaudeIdle([rule, "❯ ", "─".repeat(40), footer].join("\n"))).toBe(true);
    expect(isClaudeIdle([rule, '❯ Try "how does <filepath> work?"', "─".repeat(40), footer].join("\n"))).toBe(true);
  });
  it("is busy while a turn runs or a dialog is open", () => {
    expect(isClaudeIdle(["✻ Thinking… (12s · esc to interrupt)", rule, "❯ ", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle(["Do you want to proceed?", "❯ 1. Yes", "  2. No", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle("starting…")).toBe(false);
  });
  it("parses the RC session URL and the transcript directory", () => {
    expect(parseClaudeRcUrl("Continue at https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV now"))
      .toBe("https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV");
    expect(projectDir("/Volumes/NVM/Paperclip/tmp/claude-rc-scratch"))
      .toMatch(/\.claude\/projects\/-Volumes-NVM-Paperclip-tmp-claude-rc-scratch$/);
  });
});
