import { describe, expect, it } from "vitest";
import { sourceTrustMetadataSchema, trustAuthorizationPolicySchema } from "./trust-policy.js";

describe("trustAuthorizationPolicySchema", () => {
  it("accepts an empty legacy protected-agent approval reason", () => {
    const result = trustAuthorizationPolicySchema.parse({
      protectedAgent: {
        requiresApproval: true,
        approvalReason: "",
      },
    });

    expect(result.protectedAgent).toMatchObject({
      requiresApproval: true,
      approvalReason: "",
    });
  });

  it("still requires a non-empty canonical assignment block reason", () => {
    const result = trustAuthorizationPolicySchema.safeParse({
      protectedAgent: {
        blockAssignment: true,
        blockReason: "",
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("sourceTrustMetadataSchema comment authoring source", () => {
  it.each([
    "you",
    "via_chatgpt",
    "agent",
    "system",
  ] as const)("accepts %s comment source", (commentAuthoringSource) => {
    expect(sourceTrustMetadataSchema.parse({ commentAuthoringSource })).toEqual({
      commentAuthoringSource,
    });
  });

  it("keeps existing low-trust metadata valid and rejects an incomplete trust pair", () => {
    expect(sourceTrustMetadataSchema.safeParse({
      preset: "low_trust_review",
      disposition: "quarantined",
    }).success).toBe(true);
    expect(sourceTrustMetadataSchema.safeParse({
      preset: "low_trust_review",
      commentAuthoringSource: "agent",
    }).success).toBe(false);
  });
});
