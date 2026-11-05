import { describe, expect, it } from "vitest";
import {
  commentAuthoringSourceForActor,
  commentAuthoringSourceForAuthorType,
  withCommentAuthoringSource,
} from "./source-trust.js";

describe("issue comment authoring source", () => {
  it.each([
    [{ actorType: "board", actorSource: "session" }, "you"],
    [{ actorType: "board", actorSource: "mcp_oauth" }, "via_chatgpt"],
    [{ actorType: "agent", actorSource: "agent_jwt" }, "agent"],
    [{ actorType: "none", actorSource: "none" }, "system"],
  ] as const)("maps %s to %s", (actor, source) => {
    expect(commentAuthoringSourceForActor(actor)).toBe(source);
  });

  it.each([
    ["user", "you"],
    ["agent", "agent"],
    ["system", "system"],
  ] as const)("defaults %s comments to %s", (authorType, source) => {
    expect(commentAuthoringSourceForAuthorType(authorType)).toBe(source);
  });

  it("adds the authoring source without discarding existing trust details", () => {
    expect(withCommentAuthoringSource({
      preset: "low_trust_review",
      disposition: "quarantined",
      sourceRunId: "run-short",
    }, "agent")).toEqual({
      preset: "low_trust_review",
      disposition: "quarantined",
      sourceRunId: "run-short",
      commentAuthoringSource: "agent",
    });
  });
});
