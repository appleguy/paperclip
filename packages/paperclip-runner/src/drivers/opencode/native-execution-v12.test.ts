import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseNativeExecutionInput } from "../../contracts/native-execution.js";
import { canonicalNativeRuntimeContextDigest, NATIVE_RUNTIME_ASSET_SCHEMA } from "../../contracts/runtime-context.js";
import { createNativeSessionBackend } from "../../backends/native-backend-factory.js";

const digest = "0".repeat(64), text = "instructions";
const context = { prompt: { revision: "r", text, digest: createHash("sha256").update(text).digest("hex") }, instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 1 } }, skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null } };
const input = { schema: "paperclip.native-execution-input.v12", binding: { companyId: "c", runId: "r", issueId: "i", agentId: "a", executionWorkspaceId: "w" }, task: { identifier: "I", title: "Task", description: null, prompt: "task", workMode: "standard" }, workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, session: { normalizedSessionId: "session", driverKind: "opencode_shared_v2", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } }, provider: { kind: "opencode_shared_v2", model: "fixture/model", effort: "high", cliVersion: "2.2.5" }, completionContract: { id: "c", sha256: "abc", schemaVersion: "v1", contract: { revision: "1", objective: "task", criteria: [{ id: "c", requirement: "done" }] } }, interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null, runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, homeMode: "preconfigured" };
describe("OpenCode shared v12 admission", () => {
  it("parses the exact provider without falling back to another backend", () => { const parsed = parseNativeExecutionInput(input); expect(parsed.provider).toEqual(input.provider); expect(() => createNativeSessionBackend(parsed)).toThrow(/server-owned native backend/); });
  it("rejects foreign authority, missing model and changed native version", () => { expect(() => parseNativeExecutionInput({ ...input, provider: { ...input.provider, leaseId: "forged" } })).toThrow(); expect(() => parseNativeExecutionInput({ ...input, provider: { ...input.provider, model: "" } })).toThrow(); expect(() => parseNativeExecutionInput({ ...input, provider: { ...input.provider, cliVersion: "other" } })).toThrow(); });
  it("requires the exact supplied session and never invents one", () => {
    for (const normalizedSessionId of [null, "", "   "]) {
      expect(() => parseNativeExecutionInput({ ...input, session: { ...input.session, normalizedSessionId } })).toThrow();
    }
    expect(parseNativeExecutionInput(input).session.normalizedSessionId).toBe(input.session.normalizedSessionId);
  });
  it("selects v2 only for the exact admitted server identity and settings", () => {
    const parsed = parseNativeExecutionInput(input);
    const port = { identity: { runId: "r", sessionId: "session", companyId: "c", issueId: "i", agentId: "a" }, runnerInstanceId: "runner", providerSessionId: "ses_fixture", async verify() {}, async readReceipt() { return null; }, async dispatch() {}, async startObservation() {}, async close() {}, async waitForReceipt(): Promise<never> { throw new Error("not used"); } };
    const authority = { port, model: "fixture/model", effort: "high", version: "2.2.5" as const };
    expect(createNativeSessionBackend(parsed, { opencodeSharedAuthority: authority })).toBeDefined();
    expect(() => createNativeSessionBackend(parsed, { opencodeSharedAuthority: { ...authority, model: "other/model" } })).toThrow();
    expect(() => createNativeSessionBackend(parsed, { opencodeSharedAuthority: { ...authority, effort: "low" } })).toThrow();
    expect(() => createNativeSessionBackend(parsed, { opencodeSharedAuthority: { ...authority, port: { ...port, identity: { ...port.identity, runId: "foreign" } } } })).toThrow();
  });
});
