import { describe, expect, it } from "vitest";
import { classifyOpenCodeError } from "./nar-attempt.js";

describe("classifyOpenCodeError", () => {
  it("types the observed failure classes", () => {
    expect(classifyOpenCodeError({ type: "provider.rate-limit", message: "Too many requests", status: 429 })?.code).toBe("opencode_provider_rate_limit");
    expect(classifyOpenCodeError({ type: "provider.no-route", message: "Variant unavailable for x: medium" })?.code).toBe("opencode_variant_unavailable");
    expect(classifyOpenCodeError({ message: "this server was started without the vision encoder" })?.code).toBe("opencode_backend_vision_encoder_missing");
    expect(classifyOpenCodeError({ type: "provider.unknown", message: "boom" })?.code).toBe("opencode_session_failed");
    expect(classifyOpenCodeError(null)).toBeNull();
  });
});
