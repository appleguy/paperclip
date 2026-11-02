import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createSharedCodexThreadConfig } from "../../vendor/paperclip-runner/index.js";
const mocks = vi.hoisted(() => ({ begin: vi.fn(), preflight: vi.fn(), inspect: vi.fn() }));
vi.mock("./codex-shared-goal-authority.js", async (original) => ({ ...(await original<typeof import("./codex-shared-goal-authority.js")>()), beginCodexManagedThreadBootstrap: mocks.begin, preflightCodexManagedThreadBootstrap: mocks.preflight }));
vi.mock("./codex-shared-daemon.js", () => ({ inspectCodexSharedDaemon: mocks.inspect }));
import { createAttestedCodexSharedOption, createCodexSharedAdmission } from "./codex-shared-admission.js";
const cwd = "/work/space";
const threadConfig = createSharedCodexThreadConfig({ cwd, readOnly: false, webSearchDisabled: true, networkAccess: false, codexHome: "/private/home", codexExecutable: "/bin/sh", path: "/usr/bin:/bin" });
const launch = { cwd, instructions: "Do work", authorizedTools: { schema: "tools" }, approvalPolicy: "never" as const, readOnly: false, webSearchDisabled: true, threadConfig };
const binding = { companyId: "c", projectId: "p", goalId: "g", issueId: "i", agentId: "a", runId: "r", normalizedSessionId: "s", runnerInstanceId: "ri", executionWorkspaceId: "w", environmentLeaseId: "l", taskSessionId: "t", delegationGrantId: "d", delegationRevision: "v", hostId: "h", threadId: "pending", processGeneration: "pg", protocolVersion: "0", model: "m", effort: "high", writerGrantId: "r", writerEpoch: 1, leaseOwner: "o", leaseAttempt: 1, controllerBootId: "b", controllerPid: 1, controllerProcessStartedAt: new Date(0), controllerGeneration: 1 };
const template = (name: string, dir = cwd) => ({ authorizedTools: launch.authorizedTools, provider: { provider: "codex", model: "m", cwd: dir, instructions: launch.instructions, approvalPolicy: "never", readOnly: false, sharedDaemon: { bootstrapId: "boot", threadId: "", threadName: name, writer: { runId: "r", normalizedSessionId: "s", runnerInstanceId: "ri", grantId: "r", epoch: 1, observationEpochId: "obs", managedTools: true, managedBootstrapId: "boot", reasoningEffort: "high", threadConfig } } } });
beforeEach(() => { vi.clearAllMocks(); mocks.begin.mockResolvedValue("fresh"); mocks.preflight.mockResolvedValue(undefined); mocks.inspect.mockResolvedValue({ socketPath: "/socket", daemonGeneration: "gen", codexHome: "/private/home", appServerVersion: "1", peer: { pid: 1, startSeconds: 1, startMicroseconds: 0, executable: "/bin/sh" } }); });
it("carries the display name into the attested daemon option", async () => {
  const option = await createAttestedCodexSharedOption({ db: {} as Db, binding, bootstrapId: "boot", observationEpochId: "obs", launch, threadName: "Issue · Agent", codexExecutable: "/bin/sh", codexHome: "/private/home", runnerExecutable: "/runner", home: "/home" });
  expect(option.daemon.threadName).toBe("Issue · Agent");
  expect(option.daemon.writer.threadConfig).toEqual(threadConfig);
});
it("excludes only the display name from the admitted configuration digest", async () => {
  const reserve = async (name: string) => createCodexSharedAdmission({ db: {} as Db, binding, bootstrapId: "boot", observationEpochId: "obs", launch, attestDaemon: async () => {} }).bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template(name) });
  await reserve("Old name"); await reserve("New name");
  expect(mocks.begin.mock.calls[0]![2].configurationDigest).toBe(mocks.begin.mock.calls[1]![2].configurationDigest);
  const admission = createCodexSharedAdmission({ db: {} as Db, binding, bootstrapId: "boot", observationEpochId: "obs", launch, attestDaemon: async () => {} });
  await expect(admission.bootstrapAuthority.reserve({ bootstrapId: "boot", runAttachTemplate: template("New name", "/foreign") })).rejects.toThrow("launch_contract_mismatch");
});
