import { describe, expect, it } from "vitest";
import { resolveCodexSharedRegistration } from "./codex-shared-registration.js";

const host = {
  PAPERCLIP_CODEX_SHARED_HOST_ID: " host ",
  PAPERCLIP_CODEX_SHARED_EXECUTABLE: " /codex ",
  PAPERCLIP_CODEX_SHARED_CODEX_HOME: " /codex-home ",
  PAPERCLIP_CODEX_SHARED_HOME: " /home ",
};
const expected = { hostId: "host", codexExecutable: "/codex", codexHome: "/codex-home", home: "/home" };

describe("resolveCodexSharedRegistration", () => {
  it("preserves legacy opt-in and ignores other agents", () => {
    const env = { ...host, PAPERCLIP_CODEX_SHARED_AGENT_ID: " a ", PAPERCLIP_CODEX_SHARED_GRANT_ID: " grant-a " };
    expect(resolveCodexSharedRegistration(env, "a")).toEqual({ ...expected, grantId: "grant-a" });
    expect(resolveCodexSharedRegistration(env, "b")).toBeNull();
  });

  it("selects each mapped grant, preferring the map over a legacy entry", () => {
    const env = { ...host, PAPERCLIP_CODEX_SHARED_AGENT_ID: "a", PAPERCLIP_CODEX_SHARED_GRANT_ID: "old", PAPERCLIP_CODEX_SHARED_GRANTS: '{"a":"grant-a","b":"grant-b"}' };
    expect(resolveCodexSharedRegistration(env, "a")).toEqual({ ...expected, grantId: "grant-a" });
    expect(resolveCodexSharedRegistration(env, "b")).toEqual({ ...expected, grantId: "grant-b" });
    expect(resolveCodexSharedRegistration(env, "c")).toBeNull();
    expect(resolveCodexSharedRegistration({ ...env, PAPERCLIP_CODEX_SHARED_GRANTS: '{}' }, "a")?.grantId).toBe("old");
  });

  it("rejects malformed registrations instead of silently changing routes", () => {
    for (const grants of ["{", "[]", '{"a":" "}']) {
      expect(() => resolveCodexSharedRegistration({ ...host, PAPERCLIP_CODEX_SHARED_GRANTS: grants }, "a")).toThrow("codex_shared_registration_unavailable");
    }
    expect(() => resolveCodexSharedRegistration({ PAPERCLIP_CODEX_SHARED_AGENT_ID: "a" }, "a")).toThrow("codex_shared_registration_unavailable");
    expect(() => resolveCodexSharedRegistration({ PAPERCLIP_CODEX_SHARED_GRANTS: '{"a":"g"}' }, "a")).toThrow("codex_shared_registration_unavailable");
    expect(resolveCodexSharedRegistration({}, "a")).toBeNull();
  });
  it("enables new agents globally while respecting explicit denials and grants", () => {
    const env = {...host, PAPERCLIP_CODEX_SHARED_DEFAULT:"1", PAPERCLIP_CODEX_SHARED_GRANTS:'{"a":false,"b":null,"c":"override"}'};
    expect(resolveCodexSharedRegistration(env,"a")).toBeNull();
    expect(resolveCodexSharedRegistration(env,"b")).toBeNull();
    expect(resolveCodexSharedRegistration(env,"c")?.grantId).toBe("override");
    expect(resolveCodexSharedRegistration(env,"new")?.grantId).toBe("");
  });
});
