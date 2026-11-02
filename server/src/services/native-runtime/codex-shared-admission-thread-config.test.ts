import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { createCodexSharedAdmission, type CodexSharedLaunchContract } from "./codex-shared-admission.js";
import { createSharedCodexThreadConfig } from "../../vendor/paperclip-runner/index.js";

const cwd = "/work/space";
const policy = (over: Partial<Parameters<typeof createSharedCodexThreadConfig>[0]> = {}) => createSharedCodexThreadConfig({
  cwd, readOnly: false, webSearchDisabled: true, networkAccess: false, codexHome: "/private/codex-home",
  codexExecutable: "/bin/sh", path: "/usr/bin:/bin", ...over,
});
const tools = { schema: "tools" };
const binding = { companyId: "c", projectId: "p", goalId: "g", issueId: "i", agentId: "a", runId: "r", normalizedSessionId: "s", runnerInstanceId: "ri", executionWorkspaceId: "w", environmentLeaseId: "l", taskSessionId: "t", delegationGrantId: "d", delegationRevision: "v", hostId: "h", threadId: "pending", processGeneration: "pg", protocolVersion: "0", model: "m", effort: "high", writerGrantId: "r", writerEpoch: 1, leaseOwner: "o", leaseAttempt: 1, controllerBootId: "b", controllerPid: 1, controllerProcessStartedAt: new Date(0), controllerGeneration: 1 } as never;
const launch = (over: Partial<CodexSharedLaunchContract> = {}): CodexSharedLaunchContract => ({ cwd, instructions: "Do the work", authorizedTools: tools, approvalPolicy: "never", readOnly: false, webSearchDisabled: true, threadConfig: policy(), ...over });
const template = (threadConfig: unknown) => ({
  authorizedTools: tools,
  provider: { provider: "codex", model: "m", cwd, instructions: "Do the work", approvalPolicy: "never", readOnly: false,
    sharedDaemon: { bootstrapId: "boot", threadId: "", writer: { runId: "r", normalizedSessionId: "s", runnerInstanceId: "ri", grantId: "r", epoch: 1, observationEpochId: "obs", managedTools: true, managedBootstrapId: "boot", reasoningEffort: "high", threadConfig } } },
});
const admission = (contract: CodexSharedLaunchContract) => createCodexSharedAdmission({
  db: {} as Db, binding, bootstrapId: "boot", observationEpochId: "obs", launch: contract,
  attestDaemon: async () => { throw new Error("attested"); },
});
const clone = () => structuredClone(policy()) as Record<string, any>;

describe("shared Codex admission binds the server-generated thread config exactly", () => {
  it("accepts the generated policy and reaches daemon attestation", async () => {
    await expect(admission(launch()).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(policy()) })).rejects.toThrow("attested");
  });

  it.each([
    ["network widened", (c: Record<string, any>) => { c.permissions["paperclip-runner-workspace-only"].network.enabled = true; }],
    ["extra absolute read root", (c: Record<string, any>) => { c.permissions["paperclip-runner-workspace-only"].filesystem["/Users/attacker"] = "read"; }],
    ["changed PATH", (c: Record<string, any>) => { c.shell_environment_policy.set.PATH = "/tmp/attacker:/usr/bin"; }],
    ["extra environment name", (c: Record<string, any>) => { c.shell_environment_policy.include_only.push("SECRET"); }],
    ["web search removed", (c: Record<string, any>) => { delete c.web_search; }],
  ])("rejects a runner template whose policy differs: %s", async (_name, change) => {
    const mutated = clone(); change(mutated);
    await expect(admission(launch()).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(mutated) })).rejects.toThrow("codex_shared_thread_config_mismatch");
    await expect(admission(launch()).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(undefined) })).rejects.toThrow("codex_shared_thread_config_mismatch");
  });

  it("keeps legitimately admitted networking exact in both directions", async () => {
    const networked = policy({ networkAccess: true });
    await expect(admission(launch({ threadConfig: networked })).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(networked) })).rejects.toThrow("attested");
    await expect(admission(launch({ threadConfig: networked })).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(policy()) })).rejects.toThrow("codex_shared_thread_config_mismatch");
  });

  it("refuses a launch contract whose policy does not carry Core's web-search or workspace selection", () => {
    const noSearch = clone(); delete noSearch.web_search;
    expect(() => admission(launch({ threadConfig: noSearch }))).toThrow("codex_shared_launch_contract_invalid");
    expect(() => admission(launch({ readOnly: true }))).not.toThrow(); // a writable-profile config is still shaped for read-only use
    const writeOutside = clone(); writeOutside.permissions["paperclip-runner-workspace-only"].filesystem["/elsewhere"] = "write";
    expect(() => admission(launch({ threadConfig: writeOutside }))).toThrow("codex_shared_launch_contract_invalid");
  });
});
