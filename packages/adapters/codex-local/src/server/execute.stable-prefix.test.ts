import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the outbound-auth harness in execute.test.ts: a remote-ssh execution
// target with the process launch mocked so the REAL `execute()` wiring builds
// and reports the launch prompt without touching a live Codex or an ssh host.
const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

const REMOTE_RUNTIME_ROOT = "/remote/workspace/.paperclip-runtime/codex";

prepareAdapterExecutionTargetRuntime.mockImplementation(async () => ({
  target: { kind: "remote", transport: "ssh" },
  workspaceRemoteDir: "/remote/workspace",
  runtimeRootDir: REMOTE_RUNTIME_ROOT,
  assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
  restoreWorkspace: async () => undefined,
}));

function commonPrefixBytes(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  let offset = 0;
  while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++;
  return offset;
}

describe("codex execute — stable-first launch prompt", () => {
  let rootDir: string;
  let codexHome: string;
  let workspaceDir: string;
  let instructionsFilePath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stable-prefix-"));
    workspaceDir = path.join(rootDir, "workspace");
    codexHome = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    // External CODEX_HOME (outside the managed company tree) so no managed
    // seeding rewrites auth.json; mirrors the outbound-auth harness.
    await writeFile(path.join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    instructionsFilePath = path.join(rootDir, "AGENTS.md");
    await writeFile(instructionsFilePath, "Stable launch instructions.\n", "utf8");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function launchPrompt(runId: string, issue: {
    id: string;
    identifier: string;
    title: string;
    guidance: string;
    task: string;
    commentBody: string;
  }): Promise<string> {
    let prompt = "";
    await execute({
      runId,
      agent: {
        id: "agent-stable",
        companyId: "company-stable",
        name: "Stable Agent",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: issue.id },
      config: {
        command: "codex",
        engine: "cli",
        cwd: workspaceDir,
        instructionsFilePath,
        bootstrapPromptTemplate: "Stable bootstrap instructions.",
        promptTemplate: "Stable agent template.",
        env: { CODEX_HOME: codexHome },
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
        paperclipTaskCommunicationGuidance: issue.guidance,
        paperclipTaskMarkdownAssignment: issue.task,
        paperclipWake: {
          reason: "issue_assigned",
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.title,
            status: "in_progress",
            workMode: "standard",
          },
          comments: [{
            id: `${issue.id}-comment`,
            body: issue.commentBody,
            authorType: "user",
            authorId: "user-1",
            createdAt: "2026-09-22T00:00:00.000Z",
            updatedAt: "2026-09-22T00:00:00.000Z",
            deleted: false,
            sourceTrust: "human",
          }],
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    return prompt;
  }

  it("keeps the reusable agent sections as a shared prefix across issues of one agent", async () => {
    const promptA = await launchPrompt("run-stable-a", {
      id: "issue-a",
      identifier: "PAP-A",
      title: "Release ledger A",
      guidance: "Communication guidance for issue A.",
      task: "Task context for issue A.",
      commentBody: "Append ledger entry A.",
    });
    const promptB = await launchPrompt("run-stable-b", {
      id: "issue-b",
      identifier: "PAP-B",
      title: "Release ledger B",
      guidance: "Communication guidance for issue B.",
      task: "Task context for issue B.",
      commentBody: "Append ledger entry B.",
    });
    expect(promptA.length).toBeGreaterThan(0);
    expect(promptB.length).toBeGreaterThan(0);

    const stablePrefix = [
      "Stable launch instructions.",
      "Stable bootstrap instructions.",
      `The agent instructions earlier in this prompt were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${path.dirname(instructionsFilePath)}/.`,
      "Stable agent template.",
    ].join("\n\n");
    expect(promptA.startsWith(stablePrefix)).toBe(true);
    expect(promptB.startsWith(stablePrefix)).toBe(true);
    expect(commonPrefixBytes(promptA, promptB)).toBeGreaterThanOrEqual(Buffer.byteLength(stablePrefix));

    // Issue detail and per-run data start only after the stable sections.
    expect(promptA.indexOf("Communication guidance for issue A.")).toBeGreaterThan(stablePrefix.length);
    expect(promptA.indexOf("Task context for issue A.")).toBeGreaterThan(stablePrefix.length);
    expect(promptA).not.toContain("issue-b");
    expect(promptB).not.toContain("issue-a");
    expect(promptA).toContain("Append ledger entry A.");
    expect(promptB).toContain("Append ledger entry B.");
  });
});
