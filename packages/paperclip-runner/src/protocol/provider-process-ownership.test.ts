import { describe, expect, it } from "vitest";
import { readProviderProcessOwnership } from "./provider-process-ownership.js";
import { resolveRunnerdSessionIdentity } from "../live/runnerd-codex-transport.js";

const ownership = { kind: "shared_daemon", socketPath: "/native/control.sock", daemonGeneration: "birth-1", threadId: "thread-1", codexHome: "/native/home" };
const identity = { threadId: "thread-1", providerDescriptor: { processOwnership: ownership } };
describe("native process ownership", () => {
  it("never derives child ownership from a shared daemon session", () => {
    expect(readProviderProcessOwnership(identity)).toEqual(ownership);
    expect(resolveRunnerdSessionIdentity(identity)).toEqual({ processId: null, threadId: "thread-1", sessionId: null });
    expect(readProviderProcessOwnership({ processId: 42 })).toBeUndefined();
  });
  it("rejects process aliases and ownership conflicts instead of falling back to legacy", () => {
    for (const field of ["processId", "process_id", "pid", "agentProcessId"]) {
      for (const location of ["root", "runtimeIdentity", "providerDescriptor"]) {
        const value = structuredClone(identity) as Record<string, any>;
        if (location === "root") value[field] = 42;
        else value[location] = { ...value[location], [field]: null };
        expect(() => resolveRunnerdSessionIdentity(value)).toThrow("omit process IDs");
      }
    }
    expect(() => readProviderProcessOwnership({ ...identity, processOwnership: { kind: "owned_child" } })).toThrow("conflicting");
    expect(() => readProviderProcessOwnership({ ...identity, threadId: "wrong" })).toThrow("thread identity");
    expect(() => readProviderProcessOwnership({ ...identity, providerDescriptor: { ...identity.providerDescriptor, providerSessionId: "foreign" } })).toThrow("thread identity");
    expect(() => readProviderProcessOwnership({ ...identity, runtimeIdentity: { threadId: "foreign" } })).toThrow("thread identity");
    expect(() => readProviderProcessOwnership({ processOwnership: null })).toThrow("invalid");
    expect(() => readProviderProcessOwnership({ processOwnership: { ...ownership, socketPath: "relative" } })).toThrow("invalid");
  });
});
