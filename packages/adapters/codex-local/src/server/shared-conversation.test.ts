import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSharedCodexThread, settleSharedCodexThread, sharedConversationStateDir } from "./shared-conversation.js";

describe("keepConversation seat thread", () => {
  it("is on only with keepConversation and an absolute stateDir", () => {
    expect(sharedConversationStateDir({ keepConversation: true, stateDir: "/s" })).toBe("/s");
    expect(sharedConversationStateDir({ keepConversation: true, stateDir: "rel" })).toBeNull();
    expect(sharedConversationStateDir({ keepConversation: true })).toBeNull();
    expect(sharedConversationStateDir({ stateDir: "/s" })).toBeNull();
  });

  it("records the run's thread, keeps it across runs, and forgets it on clearSession", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-seat-"));
    expect(await readSharedCodexThread(dir)).toBeNull();
    await settleSharedCodexThread(dir, { sessionId: "t-1" }, "/w/a");
    expect(await readSharedCodexThread(dir)).toEqual({ sessionId: "t-1", cwd: "/w/a" });
    await settleSharedCodexThread(dir, { sessionId: null, clearSession: false }, "/w/b");
    expect((await readSharedCodexThread(dir))?.sessionId).toBe("t-1");
    await settleSharedCodexThread(dir, { sessionId: null, clearSession: true }, "/w/b");
    expect(await readSharedCodexThread(dir)).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
