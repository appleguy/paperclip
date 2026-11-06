import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { readableRuntimePath } from "@paperclipai/adapter-utils/readable-runtime-paths";
import { assertAssembledPrompt, preflightSessionPrompt, applyPromptRotation } from "@paperclipai/adapter-utils/token-preflight";
import { createUsageCheckpointLog } from "@paperclipai/adapter-utils/usage-checkpoint";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeout,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectPaperclipPromptSections,
  stripConnectionGuidanceWithoutIntent,
  isPaperclipRecoveryWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl, createOpenCodeJsonlParser } from "./parse.js";
import { createOpenCodeAttemptProgressGuard } from "./attempt-progress.js";
import { runNarOpenCodeAttempt } from "./nar/nar-attempt.js";
import { runHandleNote, writeRunHandle } from "./nar/run-handle.js";
import { sessionTitleFor } from "./nar/opencode-http-driver.js";
import { OpenCodeSharedSessionWait, prepareSharedOpenCodeSession } from "./shared-session-recovery.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
} from "./models.js";
import { removeMaintainerOnlySkillSymlinks } from "@paperclipai/adapter-utils/server-utils";
import { apiKeyBillingType } from "@paperclipai/adapter-utils/api-billing-type";
import { prepareOpenCodeRuntimeConfig, prepareManagedOpenCodeRemoteHomes } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";
import { resolveOpenCodeSkillsHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return provider === "openai" ? inferOpenAiCompatibleBiller(env, "openai") ?? "unknown" : provider ?? "unknown";
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}) {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return;
  }

  const defaultProbeTimeoutSec =
    input.executionTarget.kind === "remote" && input.executionTarget.transport === "sandbox"
      ? REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC
      : REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, defaultProbeTimeoutSec)
    : defaultProbeTimeoutSec;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    input.executionTarget,
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );

  // The remote availability probe is a best-effort pre-flight guard, not a gate.
  // If `opencode models` itself cannot run on the target — timeout, transient CLI
  // error, provider hiccup — do NOT abort the run. The real invocation is
  // authoritative, so a probe that can't execute must never be fatal. (Previously
  // these threw and crashed runs mid-flight, losing the agent's work + disposition.)
  if (probe.timedOut) {
    console.warn(
      `[opencode-local] Remote model availability probe for "${model}" timed out after ${probeTimeoutSec}s; proceeding with the configured model.`,
    );
    return;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    console.warn(
      `[opencode-local] Remote \`opencode models\` could not run for "${model}"${
        detail ? ` (${detail})` : ""
      }; proceeding with the configured model.`,
    );
    return;
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    console.warn(
      `[opencode-local] Remote \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return;
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }
}

async function ensureOpenCodeSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  skillsHome = resolveOpenCodeSkillsHome({}),
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function buildOpenCodeSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skills-"));
  const target = path.join(tmp, "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(resolveLegacyPaperclipDesiredSkillNames(config, availableEntries));
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    await fs.symlink(entry.source, path.join(target, entry.runtimeName));
  }
  return target;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, openCodeSkillEntries);
  if (!executionTargetIsRemote) {
    await ensureOpenCodeSkillsInjected(
      onLog,
      openCodeSkillEntries,
      desiredOpenCodeSkillNames,
      resolveOpenCodeSkillsHome(config),
    );
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({
    env, config,
    sandboxToolOomPreference: executionTarget?.kind === "remote" && executionTarget.transport === "sandbox",
  });
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const adapterExecutionTimeout = resolveAdapterExecutionTargetTimeout(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const timeoutSec = adapterExecutionTimeout.timeoutSec;
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let localSkillsDir: string | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      localSkillsDir = await buildOpenCodeSkillsDir(config);
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OpenCode runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "opencode",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [
          {
            key: "skills",
            localDir: localSkillsDir,
            followSymlinks: true,
          },
          ...(localRuntimeConfigHome
            ? [{
              key: "xdgConfig",
              localDir: localRuntimeConfigHome,
            }]
            : []),
        ],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
      prepareManagedOpenCodeRemoteHomes({
        env: preparedRuntimeConfig.env,
        config,
        runtimeRootDir: preparedExecutionTargetRuntime.runtimeRootDir,
        runId,
        configDir: preparedExecutionTargetRuntime.assetDirs.xdgConfig,
      });
      const remoteHomeDir = config.managedAiConnection
        ? preparedRuntimeConfig.env.HOME
        : managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (remoteHomeDir && preparedExecutionTargetRuntime.assetDirs.skills) {
        const remoteSkillsDir = path.posix.join(remoteHomeDir, ".claude", "skills");
        await runAdapterExecutionTargetShellCommand(
          runId,
          executionTarget,
          `mkdir -p ${JSON.stringify(path.posix.dirname(remoteSkillsDir))} && rm -rf ${JSON.stringify(remoteSkillsDir)} && cp -a ${JSON.stringify(preparedExecutionTargetRuntime.assetDirs.skills)} ${JSON.stringify(remoteSkillsDir)}`,
          { cwd, env: preparedRuntimeConfig.env, timeoutSec, graceSec, onLog },
        );
      }
      await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    let sharedSession: Awaited<ReturnType<typeof prepareSharedOpenCodeSession>> | null = null;
    const sharedConfigPath = asString(config.sharedServerRecoveryConfigPath, "").trim();
    // Opt-in native runtime: no child process, HTTP driver against the shared server (nar/nar-attempt.ts).
    // A taskless wake (manual/on-demand, no issue) still gets a stable per-agent conversation scope
    // instead of failing "NAR runtime unavailable" before any inference.
    const narTaskId = wakeTaskId ?? (asString(runtime.taskKey, "").trim() || `agent-${agent.id}`);
    const narMode = config.nativeRuntime === "nar" && sharedConfigPath.length > 0;
    const wakeIssue = parseObject(parseObject(context.paperclipWake).issue);
    if (narMode && (executionTargetIsRemote || !narTaskId || !path.isAbsolute(sharedConfigPath))) {
      await onLog("stderr", "[paperclip] NAR OpenCode requires a local target, a task and an absolute shared config; no inference sent.\n");
      return {
        exitCode: 75, signal: null, timedOut: false,
        errorMessage: "OpenCode NAR runtime unavailable for this run; no inference sent",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false,
          reason: "nar_runtime_unavailable", providerWorkEvidence: "unverified" } },
      };
    }
    if (sharedConfigPath && !narMode) {
      // Opt-in only for the local persistent OpenCode server. Any unpaired
      // active provider turn fails before inference; never manufacture a fork.
      try {
        const taskId = wakeTaskId ?? asString(runtime.taskKey, "").trim();
        if (executionTargetIsRemote || !taskId || !path.isAbsolute(sharedConfigPath))
          throw new OpenCodeSharedSessionWait();
        sharedSession = await prepareSharedOpenCodeSession({
          configPath: sharedConfigPath, stateDir: path.dirname(sharedConfigPath), agentId: agent.id,
          taskId, runId, cwd: effectiveExecutionCwd,
          requestedSessionId: sessionId,
          signal: ctx.signal,
        });
      } catch (error) {
        if (!(error instanceof OpenCodeSharedSessionWait)) {
          // File/auth errors are not evidence that a provider is idle.
          await onLog("stderr", "[paperclip] Shared OpenCode recovery preflight unavailable; no inference sent.\n");
        }
        return {
          exitCode: 75, signal: null, timedOut: false,
          errorMessage: "OpenCode shared server has unresolved active sessions; no inference sent",
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true, reason: "shared_session_unverified" } },
        };
      }
    }
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const originalInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const resolvedInstructionsFilePath = originalInstructionsFilePath && !executionTargetIsRemote
      ? path.join(await readableRuntimePath(ctx, "instructions", path.dirname(originalInstructionsFilePath)), path.basename(originalInstructionsFilePath))
      : originalInstructionsFilePath;
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    let instructionsPathNote = "";
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix = `${instructionsContents}\n\n`;
        instructionsPathNote =
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Instructions + path directive are included in fresh-session prompts (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const buildPrompt = (resumedSession: boolean, runHandleDirective = "") => {
      const renderedInstructions = resumedSession ? "" : instructionsPrefix;
      const renderedBootstrapPrompt =
        !resumedSession && bootstrapPromptTemplate.trim().length > 0
          ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
          : "";
      const communicationGuidance = resumedSession
        ? ""
        : asString(context.paperclipTaskCommunicationGuidance, "").trim();
      // The shared selector joins this with communication guidance; keep its per-run
      // content in the tail.
      const freshSessionHandoff = resumedSession
        ? ""
        : asString(context.paperclipFreshSessionHandoffMarkdown, "").trim();
      const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
        resumedSession,
        includeCommunicationGuidance: false,
      });
      const shouldUseResumeDeltaPrompt = resumedSession && wakePrompt.length > 0;
      const renderedPrompt = context.paperclipForeignTurnContinuation === true || shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : stripConnectionGuidanceWithoutIntent(renderTemplate(promptTemplate, templateData), context);
      const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
      const recoveryNote = resumedSession && sharedSession?.resumed &&
        (sharedSession.recovered || isPaperclipRecoveryWakePayload(context.paperclipWake))
        ? "Controller restart recovery: inspect the existing session history. Do not repeat any completed tool actions; continue only unfinished work."
        : "";
      const foreignTurnNote = context.paperclipForeignTurnContinuation === true
        ? "The previous provider turn finished with untrusted results. Inspect the retained session and issue history before acting. Do not replay the previous prompt or repeat completed actions; resolve unknown outcomes before continuing unfinished work."
        : "";
      // Keep the reusable agent prompt ahead of task-specific and per-run data.
      const basePrompt = joinPromptSections([
        renderedInstructions,
        renderedBootstrapPrompt,
        communicationGuidance,
        renderedPrompt,
        taskContextNote,
        recoveryNote,
        foreignTurnNote,
        sessionHandoffNote,
        freshSessionHandoff,
        resumedSession ? "" : instructionsPathNote,
        runHandleDirective,
        wakePrompt,
      ]);
      return {
        basePrompt,
        promptMetrics: {
          promptChars: basePrompt.length,
          instructionsChars: renderedInstructions.length,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          taskContextChars: taskContextNote.length,
          sessionHandoffChars: sessionHandoffNote.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
      };
    };

    // Optional diagnostic: surface OpenCode's own logs on stderr (captured into the
    // run result) so failures that OpenCode otherwise wraps as an opaque
    // "Unexpected server error" can be diagnosed in remote/sandbox runs where the
    // log file is unreachable. Toggle via PAPERCLIP_OPENCODE_PRINT_LOGS (run env,
    // then process env).
    const printLogs = isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["run", "--format", "json"];
      if (printLogs) args.push("--print-logs");
      if (resumeSessionId ?? sharedSession?.sessionId) args.push("--session", (resumeSessionId ?? sharedSession?.sessionId)!);
      if (model) args.push("--model", model);
      if (variant) args.push("--variant", variant);
      // OpenCode prefers the inherited PWD over process.cwd(). Use the realized
      // workspace unless the operator already selected a directory explicitly.
      const optionTerminator = extraArgs.indexOf("--");
      const extraOptionArgs = optionTerminator === -1 ? extraArgs : extraArgs.slice(0, optionTerminator);
      if (!extraOptionArgs.some((arg) => arg === "--dir" || arg.startsWith("--dir="))) {
        args.push("--dir", effectiveExecutionCwd);
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    // Remote targets receive only the prepared environment, never host keys.
    const accountingEnv = executionTargetIsRemote ? preparedRuntimeConfig.env : runtimeEnv;
    // The bridge runs on this host; the public HTTPS URL uses a private CA that node fetch rejects.
    const narApiUrl = `http://127.0.0.1:${process.env.PORT || 3100}`;
    const runHandle = narMode && authToken && narApiUrl
      ? await writeRunHandle({
          configPath: sharedConfigPath, apiUrl: narApiUrl, apiKey: authToken, runId, agentId: agent.id,
          companyId: agent.companyId, ttlMs: (timeoutSec > 0 ? timeoutSec * 1000 : 6 * 3600_000) + 600_000,
        })
      : null;
    const runAttempt = async (resumeSessionId: string | null) => {
      await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
      const runHandleDirective = runHandle ? runHandleNote(runHandle.handle) : "";
      let { basePrompt, promptMetrics } = buildPrompt(Boolean(resumeSessionId), runHandleDirective);
      let prompt = basePrompt;
      const preflight = async (actualSessionId?: string) => {
        const gate = await preflightSessionPrompt(ctx, model, prompt, actualSessionId ?? resumeSessionId);
        if (gate.rotate) {
          if (context.paperclipForeignTurnContinuation === true) return { rotate: true, prompt };
          if (sharedSession) throw new Error(`Token preflight refused shared OpenCode CLI resume: safe generation rotation requires NAR; ${gate.reason}`);
          applyPromptRotation(ctx, gate);
          resumeSessionId = null;
          await hydrateFreshSessionHandoff(ctx, { resumedSession: false });
          ({ basePrompt, promptMetrics } = buildPrompt(false, runHandleDirective));
          prompt = basePrompt;
          await assertAssembledPrompt({ seat: agent.name, model, prompt,
            share: config.tokenPreflightShare === undefined ? undefined : Number(config.tokenPreflightShare) });
          await onLog("stderr", `[paperclip] Starting fresh: ${gate.reason}\n`);
        }
        return { rotate: gate.rotate, prompt };
      };
      if (!narMode) await preflight();
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics: { ...promptMetrics, promptChars: prompt.length },
          context,
        });
      }

      if (narMode) {
        // Own cancellation before the first shared-server request. Without this,
        // heartbeat Stop has no registered adapter controller to abort.
        await ctx.onCancellationReady?.();
        const priorSession = parseObject(context.paperclipRestartReattachSession);
        const priorParams = parseObject(priorSession.sessionParams);
        const priorBinding = parseObject(priorParams.narBinding);
        const hasPriorBinding = Object.hasOwn(priorParams, "narBinding");
        const priorValid = priorBinding.schema === "paperclip.opencode-binding.v1" && priorBinding.runId === runId &&
          priorBinding.agentId === agent.id && priorBinding.taskId === narTaskId &&
          priorBinding.configPath === sharedConfigPath && priorParams.cwd === effectiveExecutionCwd &&
          (priorBinding.kind === "submit" || priorBinding.kind === "rejoin") &&
          typeof priorBinding.providerOrigin === "string" && priorBinding.providerOrigin.length > 0 &&
          typeof priorBinding.messageId === "string" && priorBinding.messageId.length > 0 &&
          typeof priorSession.sessionId === "string" && priorSession.sessionId.length > 0 &&
          priorParams.sessionId === priorSession.sessionId;
        return runNarOpenCodeAttempt({
          configPath: sharedConfigPath, agentId: agent.id, taskId: narTaskId, runId, cwd: effectiveExecutionCwd, resumeSessionId: sessionId,
          requireResumeSession: context.paperclipForeignTurnContinuation === true,
          expectedResumeSessionId: context.paperclipForeignTurnContinuation === true ? asString(context.paperclipForeignTurnSessionId, "") : undefined,
          model: model && variant ? `${model}#${variant}` : model, prompt, timeoutSec, signal: ctx.signal, onLog, preflight,
          requireBindingCheckpoint: true,
          onBound: ctx.onSession ? async binding => {
            await ctx.onSession!({ sessionId: binding.sessionId, sessionParams: {
              sessionId: binding.sessionId, cwd: effectiveExecutionCwd,
              narBinding: { schema: "paperclip.opencode-binding.v1", runId, agentId: agent.id,
                taskId: narTaskId, messageId: binding.messageId, kind: binding.kind,
                hostPid: binding.hostPid, configPath: sharedConfigPath, providerOrigin: binding.providerOrigin },
            } });
          } : undefined,
          reattachOnly: context.paperclipRestartReattach === true,
          ...(context.paperclipRestartReattach === true && hasPriorBinding ? priorValid
            ? { reattachBinding: { sessionId: priorSession.sessionId as string, messageId: priorBinding.messageId as string,
                providerOrigin: priorBinding.providerOrigin as string } }
            : { invalidReattachBinding: true } : {}),
          title: sessionTitleFor(wakeIssue.identifier, wakeIssue.title),
        });
      }
      const consumeAccounting = createOpenCodeJsonlParser();
      const progressGuard = createOpenCodeAttemptProgressGuard();
      let hasAccounting = false;
      const accountingLog = createUsageCheckpointLog(onLog, ctx.onUsage ?? (async () => {}), stdout => {
        hasAccounting = true;
        const parsed = consumeAccounting(stdout);
        const provider = parseModelProvider(model || null);
        return { usage: parsed.usageReported ? parsed.usage : undefined, costUsd: parsed.costUsd,
          costStatus: parsed.usageComplete || parsed.costUsd != null ? undefined : "unpriced",
          usageBasis: "per_run", provider, biller: resolveOpenCodeBiller(accountingEnv, provider), billingType: apiKeyBillingType(provider, accountingEnv), model, complete: false };
      });
      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        onProcessStopped: providerStop.beginInvocation(),
        // Keep a long sandbox run off the synchronous command HTTP request.
        // Probes and preparation keep their existing execution paths.
        ...(runtimeExecutionTarget?.kind === "remote" && runtimeExecutionTarget.transport === "sandbox"
          && runtimeExecutionTarget.providerKey === "daytona" ? { useSession: true } : {}),
        cwd,
        env: preparedRuntimeConfig.env,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog: async (stream, chunk) => {
          if (stream === "stdout") progressGuard.observe(chunk);
          await accountingLog(stream, chunk);
        },
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });
      // Parse any unterminated final record before deciding whether its usage
      // is complete. A clean exit alone cannot turn absent counters into zero.
      await accountingLog.flush();
      const retainedAccounting = consumeAccounting("");
      await accountingLog.flush({ complete: proc.exitCode === 0 && !proc.timedOut && !proc.signal
        && (retainedAccounting.usageComplete || retainedAccounting.costUsd != null) });
      // Display output is capped by the process transport. Keep accounting
      // from the full stream, including when no checkpoint callback is installed.
      const parsed = parseOpenCodeJsonl(proc.stdout);
      if (hasAccounting) {
        const retained = consumeAccounting("");
        parsed.usage = retained.usage;
        parsed.usageReported = retained.usageReported;
        parsed.usageComplete = retained.usageComplete;
        parsed.costUsd = retained.costUsd;
      }
      parsed.sessionId ??= progressGuard.observedSessionId(proc.stdout) ?? sharedSession?.sessionId ?? null;
      return { proc, rawStderr: proc.stderr, parsed,
        possibleWork: progressGuard.hasPossibleWork(proc.stdout) || parsed.hasNonErrorOutput,
        capacityRefusal: progressGuard.preInferenceCapacityRefusal(proc.stdout),
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
        possibleWork: boolean;
        capacityRefusal: boolean;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          usageComplete: false,
          usage: attempt.parsed.usageReported ? attempt.parsed.usage : undefined,
          usageBasis: "per_run",
          provider: parseModelProvider(model || null),
          biller: resolveOpenCodeBiller(accountingEnv, parseModelProvider(model || null)),
          model,
          billingType: apiKeyBillingType(parseModelProvider(model || null), accountingEnv),
          costUsd: attempt.parsed.costUsd,
          costStatus: attempt.parsed.usageComplete || attempt.parsed.costUsd != null ? undefined : "unpriced",
          // A provider or output-observation timeout can arrive before the
          // configured execution deadline. The boolean does not prove which
          // timer fired, and provider stderr is not safe exception text.
          errorMessage: "OpenCode execution timed out",
          resultJson: { adapterExecutionTimeout },
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          } as Record<string, unknown>)
        : null;

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
      const modelId = model || null;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        usageComplete: attempt.proc.exitCode === 0 && !attempt.proc.signal
          && (attempt.parsed.usageComplete || attempt.parsed.costUsd != null),
        usageBasis: "per_run",
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: attempt.parsed.usageReported ? attempt.parsed.usage : undefined,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(accountingEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: apiKeyBillingType(parseModelProvider(modelId), accountingEnv),
        costUsd: attempt.parsed.costUsd,
        costStatus: attempt.parsed.usageComplete || attempt.parsed.costUsd != null ? undefined : "unpriced",
        resultJson: {
          adapterExecutionTimeout,
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          ...(attempt.capacityRefusal && synthesizedExitCode === 1 && !attempt.proc.signal
            ? { adapterPreInferenceAdmission: {
                kind: "opencode_capacity_refusal_v1", providerWorkStarted: false,
              } }
            : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    // A shared CLI exit alone does not establish that its provider turn ended.
    // Keep the stopped callback closed unless the shared attempt exits cleanly.
    let sharedProviderUnverified = sharedSession !== null;
    let narProviderUnverified = false;
    try {
      const initial = await runAttempt(sharedSession?.resumed ? sharedSession.sessionId : sessionId);
      if (narMode) {
        // One attempt, never a stale-session retry: a second prompt could replay work.
        const result = toResult(initial);
        const termination = (initial as { providerTermination?: { proof: string; reason: string } }).providerTermination;
        if (termination) {
          // SCO-679: OpenCode proved the turn ended and the session resumes. Acknowledge so no reconciliation is needed.
          return { ...result, errorCode: "cancelled", resultJson: { ...(result.resultJson ?? {}),
            executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString(), proof: termination.proof },
            executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled", reason: termination.reason } } };
        }
        const recovery = (initial as { executionRecovery?: unknown }).executionRecovery;
        if (recovery) sharedProviderUnverified = narProviderUnverified = true;
        return recovery ? { ...result, resultJson: { ...(result.resultJson ?? {}), executionRecovery: recovery } } : result;
      }
      const sharedFinish = await sharedSession?.finish(initial.proc);
      if (sharedFinish?.providerWorkUnverified) {
        const result = toResult(initial);
        return { ...result, resultJson: { ...(result.resultJson ?? {}),
          executionRecovery: { kind: "bootstrap", providerWorkStarted: true, reason: "shared_session_unverified" } } };
      }
      sharedProviderUnverified = false;
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
      if (
        sessionId &&
        !sharedSession &&
        initialFailed &&
        !initial.proc.signal &&
        !initial.possibleWork &&
        isOpenCodeUnknownSessionError(initial.parsed.errorMessage ?? "", initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true);
      }

      return toResult(initial);
    } catch (error) {
      if (narMode) {
        sharedProviderUnverified = narProviderUnverified = true;
        return { exitCode: 75, signal: null, timedOut: false,
          errorMessage: "OpenCode NAR attempt failed with provider state unverified",
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true,
            reason: "nar_attempt_exception", providerWorkEvidence: "unverified" } } };
      }
      if (!sharedSession) throw error;
      sharedProviderUnverified = true;
      // The client can fail after submitting to the persistent server; retain
      // the run instead of letting generic setup failure imply provider exit.
      return { exitCode: 75, signal: null, timedOut: false,
        errorMessage: "Shared OpenCode client failed with provider state unverified",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true, reason: "shared_session_unverified" } } };
    } finally {
      try {
        if (!sharedProviderUnverified) await providerStop.collectBeforeRestore();
      } finally {
        if (!narProviderUnverified) {
          await Promise.all([
            paperclipBridge?.stop(),
            runHandle?.cleanup(),
            restoreRemoteWorkspace?.(),
            localSkillsDir ? fs.rm(path.dirname(localSkillsDir), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve(),
          ]);
        }
      }
    }
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
