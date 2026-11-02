import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ pid: 42123, replyId: "ses_exact", wrongInfo: false, kills: 0 }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: async () => ({ stdout: "opencode v2.2.5\n", stderr: "" }) }),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: fixture.pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { fixture.kills++; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; } });
    queueMicrotask(() => child.stdout.write("server listening on http://127.0.0.1:43210\nserver password secret\n"));
    return child;
  },
}));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, mkdtemp: async () => "/fixture/isolated" }));
vi.mock("./opencode-bound-fetch.js", () => ({ createOpenCodeBoundFetch: () => async (resource: string | URL) => {
  const url = String(resource);
  if (url.includes("/experimental/")) return new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: fixture.replyId, seq: 0 })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  return Response.json(url.endsWith("/api/info") ? { pid: fixture.wrongInfo ? 99 : fixture.pid, version: "2.2.5" } : { data: { id: fixture.replyId } });
} }));
import { startOpenCodeSharedHost } from "./opencode-shared-host.js";

describe("OpenCode host-owned admission", () => {
  it("binds only an exact session on the authenticated launched generation", async () => {
    fixture.wrongInfo = false; fixture.replyId = "ses_exact";
    const host = await startOpenCodeSharedHost({ executable: "/fixture/opencode", dataRoot: "/fixture" });
    const binding = await host.verifySession("ses_exact");
    expect(binding).toEqual({ sessionId: "ses_exact", generation: host.generation, version: "2.2.5" });
    expect(JSON.stringify(binding)).not.toContain("secret");
    fixture.replyId = "ses_foreign";
    await expect(host.verifySession("ses_exact")).rejects.toThrow("session_mismatch");
  });
  it("refuses a daemon that reports a different process", async () => {
    fixture.wrongInfo = true; fixture.kills = 0;
    await expect(startOpenCodeSharedHost({ executable: "/fixture/opencode", dataRoot: "/fixture" })).rejects.toThrow("identity_mismatch");
    expect(fixture.kills).toBe(1);
  });
  it("creates and observes one empty session without granting a second create", async () => {
    fixture.wrongInfo = false; fixture.replyId = "ses_exact";
    const host = await startOpenCodeSharedHost({ executable: "/fixture/opencode", dataRoot: "/fixture" });
    await expect(host.createEmptyObservation()).resolves.toMatchObject({ sessionId: "ses_exact", observed: true, managed: false });
    await expect(host.createEmptyObservation()).rejects.toThrow("already_attempted");
    fixture.kills = 0; await host.shutdown(); await host.shutdown(); expect(fixture.kills).toBe(1);
  });
});
