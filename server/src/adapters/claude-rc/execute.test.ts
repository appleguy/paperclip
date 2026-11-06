import { describe, expect, it } from "vitest";
import { isClaudeIdle, parseClaudeRcUrl, projectDir, shouldReuseConversation } from "./execute.js";

const rule = "─".repeat(40) + " Paperclip Claude ─";
const footer = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("claude_rc_local screen parsing", () => {
  it("treats the empty input box with the permission footer as idle", () => {
    expect(isClaudeIdle([rule, "❯ ", "─".repeat(40), footer].join("\n"))).toBe(true);
    expect(isClaudeIdle([rule, '❯ Try "how does <filepath> work?"', "─".repeat(40), footer].join("\n"))).toBe(true);
    // Seats with a status line show model and effort between the editor and the footer.
    expect(isClaudeIdle([rule, "❯ ", "─".repeat(40), "  claude-opus-5-5 · effort xhigh", "  ⏵⏵ bypass permissions on · 2 monitors"].join("\n"))).toBe(true);
  });
  it("stays idle when the last answer merely mentions a spinner word", () => {
    const answer = "  - Panes: one pane per generating session; thinking and working notes follow.";
    expect(isClaudeIdle([answer, "", "✻ Worked for 13m 42s · done 12:51 PM", rule, "❯ ", "─".repeat(40), footer].join("\n"))).toBe(true);
    expect(isClaudeIdle(["✻ Generating… (3s)", rule, "❯ ", "─".repeat(40), footer].join("\n"))).toBe(false);
  });
  it("is busy while a turn runs or a dialog is open", () => {
    expect(isClaudeIdle(["✻ Thinking… (12s · esc to interrupt)", rule, "❯ ", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle(["Do you want to proceed?", "❯ 1. Yes", "  2. No", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle("starting…")).toBe(false);
  });
  it.each(["Synthesizing", "Pondering"])("keeps a narrow %s pane busy with a truncated interrupt hint", verb => {
    expect(isClaudeIdle([`✻ ${verb}… 9m`, rule, "❯ ", footer, "  esc to …"].join("\n"))).toBe(false);
    expect(isClaudeIdle([`✻ ${verb}… 9m`, rule, "❯ ", footer].join("\n"))).toBe(false);
    expect(isClaudeIdle(["  esc to …", rule, "❯ ", footer].join("\n"))).toBe(false);
  });
  it("parses the RC session URL and the transcript directory", () => {
    expect(parseClaudeRcUrl("Continue at https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV now"))
      .toBe("https://claude.ai/code/session_01QMN4waqy2eh24tbzSQhQWV");
    expect(projectDir("/Volumes/NVM/Paperclip/tmp/claude-rc-scratch"))
      .toMatch(/\.claude\/projects\/-Volumes-NVM-Paperclip-tmp-claude-rc-scratch$/);
  });
});

import fsp from "node:fs/promises";
import nodePath from "node:path";
import { reconcileOrphanActive } from "./execute.js";
import { adoptableActive } from "../agy/execute.js";

describe("SCO-626 orphan active.json after deploy cancel", () => {
  const mk = async () => {
    const dir = await fsp.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/rc-orphan-");
    const activePath = nodePath.join(dir, "active.json");
    await fsp.writeFile(activePath, JSON.stringify({ runId: "r1", op_id: "r1", issueId: "A", receiptPath: nodePath.join(dir, "receipt-r1.json"), conversationId: "c1" }));
    return { dir, activePath };
  };
  const base = (d: { dir: string; activePath: string }, live: boolean, idle: boolean) => ({
    stateDir: d.dir, activePath: d.activePath, issueId: "B", runId: "r2",
    live: async () => live, paneIdle: async () => idle, log: () => {},
    status: async () => null,
  });
  it("retains legacy checkpoints when idle with no receipt or bridge evidence", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive(base(d, false, true))).toBe("kept");
    await fsp.stat(d.activePath);
  });
  it("keeps the checkpoint while the conversation is live or busy", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive(base(d, true, true))).toBe("kept");
    expect(await reconcileOrphanActive(base(d, false, false))).toBe("kept");
    await fsp.stat(d.activePath);
  });
  it("leaves same-issue (adoptable) checkpoints alone", async () => {
    const d = await mk();
    expect(await reconcileOrphanActive({ ...base(d, false, true), issueId: "A" })).toBe("none");
  });
  it("retains an old same-issue checkpoint even when idle with no receipt", async () => {
    const d = await mk();
    const old = JSON.parse(await fsp.readFile(d.activePath, "utf8"));
    await fsp.writeFile(d.activePath, JSON.stringify({ ...old, startedAt: new Date(Date.now() - 600_000).toISOString() }));
    expect(await reconcileOrphanActive({ ...base(d, true, true), issueId: "A" })).toBe("kept");
    expect(await reconcileOrphanActive({ ...base(d, false, true), issueId: "A" })).toBe("kept");
    await fsp.stat(d.activePath);
  });
  it("error text names the adapter", () => {
    expect(() => adoptableActive("{}", "B", "/x", "claude_rc_local")).toThrow(/^claude_rc_local previous task unresolved/);
  });
});

describe("target-busy refusals", () => {
  it("classifies occupied-seat refusals as waits, not failures", async () => {
    const { isTargetBusyRefusal } = await import("../agy/execute.js");
    for (const m of [
      "claude_rc_local previous task unresolved; inspect active.json",
      "Claude input guard refused: owner input nonempty",
      "Claude TUI not idle; leave the owner's live work intact",
      "RC URL changed; refusing to dispatch to an unverified session",
    ]) expect(isTargetBusyRefusal(m)).toBe(true);
    expect(isTargetBusyRefusal("Claude workspace trust prompt: approve this dedicated workspace")).toBe(false);
    expect(isTargetBusyRefusal("agy RC URL changed since the adopted dispatch; operator reconciliation required")).toBe(false);
  });
});

describe("claude_rc_local keepConversation", () => {
  const base = {
    enabled: true, state: { conversationId: "c1", projectId: "p1" }, newestId: "c1",
    projectId: "p2", sizeBytes: 10, maxBytes: 100,
  };
  it("clears on a project change unless the seat keeps across projects", () => {
    expect(shouldReuseConversation(base)).toBe(false);
    expect(shouldReuseConversation({ ...base, acrossProjects: true })).toBe(true);
  });
  it("still clears on a different conversation or the size cap", () => {
    expect(shouldReuseConversation({ ...base, acrossProjects: true, newestId: "c2" })).toBe(false);
    expect(shouldReuseConversation({ ...base, acrossProjects: true, sizeBytes: 100 })).toBe(false);
  });
  it("keeps busy conversations even across projects, size limits or disabled reuse", () => {
    expect(shouldReuseConversation({ ...base, busy: true })).toBe(true);
    expect(shouldReuseConversation({ ...base, busy: true, enabled: false, state: null, sizeBytes: 100 })).toBe(true);
    expect(shouldReuseConversation({ ...base, busy: true, newestId: null })).toBe(false);
  });
});

import { goalForConversation } from "./execute.js";
describe("SCO-756 managed goal on a kept conversation", () => {
  const goal = { state: "active", objective: "o", key: "active:k" };
  it("passes the key this conversation last received for the issue", () => {
    const state = { conversationId: "c", projectId: "p", issueIds: ["i"], goalKeys: { i: "active:k" } };
    expect(goalForConversation(goal, true, state, "i")).toMatchObject({ deliveredKey: "active:k" });
    expect(goalForConversation(goal, true, state, "j")).toMatchObject({ deliveredKey: null });
    expect(goalForConversation(goal, false, state, "i")).toMatchObject({ deliveredKey: null });
    expect(goalForConversation(undefined, true, state, "i")).toBeUndefined();
  });
});

describe("isPromptEmpty (SCO-771)", () => {
  it("accepts an empty prompt with NBSP and rejects typed input", async () => {
    const { isPromptEmpty } = await import("./execute.js");
    expect(isPromptEmpty("x\n❯ \n  bypass permissions on")).toBe(true);
    expect(isPromptEmpty("❯ hello\n")).toBe(false);
    expect(isPromptEmpty('✻ Thinking… (esc to interrupt)\n❯ Try "build something"\n' + footer)).toBe(true);
    expect(isPromptEmpty("✻ Working…\n❯ Press up to edit queued messages\n" + footer)).toBe(true);
    expect(isPromptEmpty('❯ Try "build something" plus my text\n')).toBe(false);
    expect(isPromptEmpty("❯ Press up to edit queued messages plus my text\n")).toBe(false);
    expect(isPromptEmpty("starting…")).toBe(false);
  });
});

describe("seatConversation (SCO-866)", () => {
  it("picks the live process whose tmux pane is this seat, not the newest file in a shared cwd", async () => {
    const { seatConversation } = await import("./execute.js");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "seatconv-"));
    const cwd = "/Volumes/NVM/Paperclip/workspaces/claude-rc";
    const rec = (sessionId: string, tmux: string, updatedAt: number, pid = process.pid) => JSON.stringify({ pid, sessionId, cwd, tmux, updatedAt });
    await writeFile(join(dir, "1.json"), rec("lead-conv", "tensor64-lead:@5.%5", 1));
    await writeFile(join(dir, "2.json"), rec("other-conv", "claude-worker:@1.%1", 9));
    await writeFile(join(dir, "3.json"), rec("dead-conv", "tensor64-lead:@2.%2", 99, 2 ** 22 + 7));
    expect(await seatConversation("tensor64-lead", cwd, dir)).toBe("lead-conv");
    expect(await seatConversation("tensor64-lead", "/elsewhere", dir)).toBeNull();
  });
});

describe("paneCwdDiffers (SCO-693)", () => {
  it("flags a different folder and ignores an equal or unknown one", async () => {
    const { paneCwdDiffers } = await import("./execute.js");
    expect(await paneCwdDiffers("/Volumes/NVM/Paperclip/workspaces/claude-rc", "/Volumes/NVM/Paperclip/workspaces/platform-lead")).toBe(true);
    expect(await paneCwdDiffers("/Volumes/NVM/Paperclip/workspaces/platform-lead", "/Volumes/NVM/Paperclip/workspaces/platform-lead/")).toBe(false);
    expect(await paneCwdDiffers("", "/x")).toBe(false);
  });
});

describe("isDevChannelPrompt (SCO-713)", () => {
  it("recognises the development-channels confirm and not an idle TUI", async () => {
    const { isDevChannelPrompt } = await import("./execute.js");
    expect(isDevChannelPrompt("WARNING: Loading development channels\n❯ 1. I am using this for local development")).toBe(true);
    expect(isDevChannelPrompt("❯ \n  bypass permissions on")).toBe(false);
  });
});
