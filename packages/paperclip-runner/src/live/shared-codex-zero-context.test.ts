import { describe, expect, it } from "vitest";
import { createSharedCodexThreadConfig } from "./shared-codex-thread-config-builder.js";
import { sharedThreadConfigViolation } from "./shared-codex-thread-config.js";

const policy = { cwd: "/workspace", readOnly: false, webSearchDisabled: true, networkAccess: false, codexHome: "/private/home", codexExecutable: "/bin/sh", path: "/usr/bin:/bin" };
const validation = { cwd: policy.cwd, readOnly: policy.readOnly, disableWebSearch: policy.webSearchDisabled };

describe("shared Codex zero-context config", () => {
  it("is opt-in and rejects incomplete or widened settings", () => {
    const normal = createSharedCodexThreadConfig(policy);
    expect(normal).not.toHaveProperty("project_doc_max_bytes");
    const zero = createSharedCodexThreadConfig({ ...policy, suppressAmbientContext: true });
    expect(sharedThreadConfigViolation(zero, validation)).toBeNull();
    expect(sharedThreadConfigViolation({ ...zero, project_doc_max_bytes: 1 }, validation)).toBe("zero_context_invalid");
    expect(sharedThreadConfigViolation({ ...zero, features: { ...zero.features as object, multi_agent: true } }, validation)).toBe("zero_context_invalid");
    const partial = { ...zero }; delete partial.skills;
    expect(sharedThreadConfigViolation(partial, validation)).toBe("zero_context_invalid");
  });
});
