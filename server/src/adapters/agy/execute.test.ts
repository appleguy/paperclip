import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adoptableActive, inputGuard, isEmptyInputBox, normalizeOneLine, parseReceipt, parseRemoteUrl, parseRemoteConversationId, pasteSettleMs, resolveAgyModel, needsCompaction, AGY_CONTEXT_LIMIT_TOKENS } from "./execute.js";

describe("agy single-RC dispatch safety", () => {
  it("parses shared /r/ base URL and drops conversation query", () => {
    expect(parseRemoteUrl("Open https://antigravity.google.com/r/abc-123-v2?p=c%2Ftopic")).toBe(
      "https://antigravity.google.com/r/abc-123-v2",
    );
    expect(parseRemoteUrl("not connected")).toBeNull();
  });

  it("reads the live /remote-control conversation even before cache updates", () => {
    const screen = "p=c%2F11111111-1111-4111-8111-111111111111\\n" +
      "> /new\\n> /remote-control\\n" +
      "https://antigravity.google.com/r/fake-v2?\\n" +
      "p=c%2F22222222-2222-4222-8222-222222222222";
    expect(parseRemoteConversationId(screen)).toBe("22222222-2222-4222-8222-222222222222");
    expect(parseRemoteConversationId("no active RC")).toBeNull();
  });

  it("reads a conversation ID that agy hard-wrapped across indented lines", () => {
    const screen = "> /remote-control\n  ⎿  Remote control on for this session.\n     Open\n" +
      "     https://antigravity.google.com/r/3b230a76-97fe-42ae-a568-d9b6a0fb9b48-v2?p=\n" +
      "     c%2F19cf69d7-66d2-457a-9aba-5c7c3c7eec66\n     on another device to continue this conversation.";
    expect(parseRemoteConversationId(screen)).toBe("19cf69d7-66d2-457a-9aba-5c7c3c7eec66");
    expect(parseRemoteUrl(screen)).toBe("https://antigravity.google.com/r/3b230a76-97fe-42ae-a568-d9b6a0fb9b48-v2");
  });

  it("forbids newline submissions that send early TUI turns", () => {
    expect(normalizeOneLine("first line\nsecond line\tthird")).toBe("first line second line third");
  });

  it("delays Enter to let long pasted prompts settle in the agy editor", () => {
    expect(pasteSettleMs(10)).toBe(800);
    expect(pasteSettleMs(12000)).toBe(2900);
    expect(pasteSettleMs(20000)).toBe(3000);
  });

  it("checks editor text independently of generating TUI markers", () => {
    expect(isEmptyInputBox([
      "Gemini 3.8 Flash", "─────────────────", ">", "─────────────────",
      "? for shortcuts                 Gemini 3.8 Flash · low",
    ].join("\n"))).toBe(true);
    expect(isEmptyInputBox([
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
  it("allows an empty editor without a status-line snapshot", () => {
    const empty = ["previous > input", "────────────", ">", "────────────", "agy idle"].join("\n");
    expect(isEmptyInputBox(empty)).toBe(true);
    expect(inputGuard(empty)).toEqual({ allowed: true, reason: "empty input editor" });
  });

  it("refuses half-typed or wrapped input and unrecognizable editors", () => {
    for (const editor of ["> half typed", "> draft\ncontinued on next line"]) {
      const screen = ["────────────", editor, "────────────", "agy idle"].join("\n");
      expect(inputGuard(screen).allowed).toBe(false);
    }
    expect(inputGuard("old > prompt\nGenerating...").allowed).toBe(false);
  });

  it("allows busy turns and queued work with an empty editor", () => {
    for (const marker of ["esc to cancel", "Generating...", "Working...", "agy working", "agy tool_use"]) {
      expect(inputGuard(["────────────", ">", "────────────", marker].join("\n")).allowed).toBe(true);
    }
  });

  it("finds the editor above the bordered running-task strip", () => {
    const screen = (editor: string) => [
      "────────────", editor, "────────────", "● /bin/sleep 40 running",
      "────────────", "? for shortcuts · 1 task(s) · /tasks", "agy working",
    ].join("\n");
    expect(inputGuard(screen(">")).allowed).toBe(true);
    expect(inputGuard(screen("> owner draft")).allowed).toBe(false);
  });

  it("persists only scoped agy statusLine fields and preserves idleSince", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agy-statusline-test-"));
    const dest = path.join(dir, "agent1", "status-line.json");
    const script = path.join(import.meta.dirname, "statusline.cjs");
    const input = (agent_state: string, cwd = "/work", conversation_id = "c1") => JSON.stringify({
      agent_state, cwd, conversation_id, email: "not-persisted@example.com",
      pending_input_count: 0, tool_confirmation_pending: false,
      context_window: { total_input_tokens: 250_000 },
    });
    const run = (value: string) => spawnSync(process.execPath, [script, dest, "/work"], { input: value, encoding: "utf8" });
    try {
      expect(run(input("idle")).status).toBe(0);
      const first = JSON.parse(await readFile(dest, "utf8"));
      expect(first.agentState).toBe("idle");
      expect(first.idleSince).toBe(first.observedAt);
      expect(first.email).toBeUndefined();
      expect(first.contextTokens).toBe(250_000);
      expect(run(input("idle")).status).toBe(0);
      const second = JSON.parse(await readFile(dest, "utf8"));
      expect(second.idleSince).toBe(first.idleSince);
      expect(run(input("working")).status).toBe(0);
      expect((JSON.parse(await readFile(dest, "utf8"))).idleSince).toBeNull();
      expect(run(input("idle", "/someone-else")).status).toBe(0);
      expect((JSON.parse(await readFile(dest, "utf8"))).agentState).toBe("working");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("adopts only the same issue's checkpoint after a crash, never another issue's", () => {
    const run = "8e5cbb55-1e72-4dda-a4f5-f0b050c2ee6c";
    const a = { runId: run, issueId: "i1", receiptPath: `/s/receipt-${run}.json`, rcUrl: "https://antigravity.google.com/r/x", conversationId: "c1" };
    expect(adoptableActive("", "i1", "/s")).toBeNull();
    expect(adoptableActive(JSON.stringify(a), "i1", "/s")?.runId).toBe(run);
    expect(adoptableActive(JSON.stringify({ ...a, receiptPath: "/s/receipt-8e5cbb551e72.json" }), "i1", "/s")?.runId).toBe(run);
    expect(() => adoptableActive(JSON.stringify(a), "i2", "/s")).toThrow(/Never replay/);
    expect(() => adoptableActive(JSON.stringify({ ...a, receiptPath: "/etc/x.json" }), "i1", "/s")).toThrow(/Never replay/);
    expect(() => adoptableActive("{not json", "i1", "/s")).toThrow(/Never replay/);
  });
});

describe("agy 200k context cap", () => {
  it("compacts only when the recorded context exceeds 200k", () => {
    expect(AGY_CONTEXT_LIMIT_TOKENS).toBe(200_000);
    expect(needsCompaction({ contextTokens: 200_000 })).toBe(false);
    expect(needsCompaction({ contextTokens: 200_001 })).toBe(true);
    expect(needsCompaction({ contextTokens: null })).toBe(false);
    expect(needsCompaction(null)).toBe(false);
  });
});

describe("resolveAgyModel", () => {
  it("defaults to flash-low and accepts Flash, Argon and Claude-via-agy tiers", () => {
    expect(resolveAgyModel(undefined)).toBe("gemini-3.8-flash-low");
    for (const m of ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-4-argon-high", "claude-opus-5-5-high", "claude-sonnet-5-5-medium"]) expect(resolveAgyModel(m)).toBe(m);
  });
  it("refuses GPT, low-tier Claude and other models", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5-low", "gpt-oss-120b-medium", "gpt-6", "gemini-3.8-pro", "gemini-3.8-flash-ultra"]) expect(() => resolveAgyModel(m)).toThrow(/permits only/);
  });
});
