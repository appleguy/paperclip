import { describe, expect, it } from "vitest";
import { boundContinuationMessages } from "./server-utils.js";

const message = (id: string, authorType: string, body: string, createdByRunId: string | null = null) => ({
  id, authorType, authorId: "a", createdByRunId, body,
  createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z", deleted: false, sourceTrust: null,
});

describe("boundContinuationMessages", () => {
  it("keeps small histories unchanged", () => {
    const messages = [message("u1", "user", "do it"), message("a1", "agent", "done", "run-1")];
    expect(boundContinuationMessages({ messages, originCommentIds: [] })).toEqual({ messages, omitted: 0, truncated: 0 });
  });

  it("keeps every human and origin message and drops the oldest agent messages", () => {
    const agent = Array.from({ length: 400 }, (_, index) => message(`a${index}`, "agent", "x".repeat(900), "run"));
    const messages = [message("u0", "user", "first owner scope"), ...agent, message("o1", "agent", "origin", "run"), message("u1", "user", "latest owner ask")];
    const result = boundContinuationMessages({ messages, originCommentIds: ["o1"] });
    const ids = result.messages.map((entry) => entry.id);
    expect(ids).toContain("u0");
    expect(ids).toContain("u1");
    expect(ids).toContain("o1");
    expect(ids).toContain("a399");
    expect(ids).not.toContain("a0");
    expect(result.omitted).toBeGreaterThan(300);
    expect(result.messages.reduce((sum, entry) => sum + entry.body.length, 0)).toBeLessThan(50_000);
    expect(ids.indexOf("u0")).toBeLessThan(ids.indexOf("a399"));
  });

  it("shortens very long agent messages", () => {
    const messages = [message("a1", "agent", "y".repeat(60_000), "run"), message("u1", "user", "ask")];
    const result = boundContinuationMessages({ messages, originCommentIds: [] });
    expect(result.truncated).toBe(1);
    expect(result.messages[0]!.body.endsWith("[truncated]")).toBe(true);
  });
});
