import { describe, expect, it, vi } from "vitest";
import type * as Guard from "./rc-guard.js";

const { codexRcDaemonDownReason, codexRemoteControlViolation } = await vi.importActual<typeof Guard>("./rc-guard.js");

const SHIM = "/Volumes/NVM/Paperclip/ops/codex-remote-control/codex-acp-rc";

describe("codex remote-control guard (SCO-912)", () => {
  it("accepts the RC shim", () => {
    expect(codexRemoteControlViolation({ engine: "acp", agentCommand: SHIM })).toBeNull();
    expect(codexRemoteControlViolation({ agentCommand: SHIM })).toBeNull();
  });
  it("rejects a config with agentCommand removed", () => {
    expect(codexRemoteControlViolation({ engine: "acp" })).toMatch(/agentCommand is missing/);
    expect(codexRemoteControlViolation({})).not.toBeNull();
  });
  it("rejects the exec/cli engine and non-RC commands", () => {
    expect(codexRemoteControlViolation({ engine: "cli", agentCommand: SHIM })).toMatch(/engine=cli/);
    expect(codexRemoteControlViolation({ agentCommand: "/x/node_modules/.bin/codex-acp" })).toMatch(/not the Remote Control shim/);
  });
  it("names a missing daemon socket", () => {
    expect(codexRcDaemonDownReason("/nonexistent/sock")).toMatch(/daemon is not running/);
  });
});
