import { RunnerdMuseDriver, type RunnerdMuseDriverOptions } from "../drivers/muse/runnerd-muse-driver.js";
import { RunnerdDotDriver, type RunnerdDotDriverOptions } from "../drivers/dot/runnerd-dot-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { PersistedHarnessSession } from "../contracts/harness-driver.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import {
  createCodexNativeSessionBackend,
  createRunnerdNativeSessionBackend,
  type CodexNativeSessionBackendOptions,
} from "./codex-native-backend.js";
import {
  createAcpxNativeSessionBackend,
  type CodexAcpxNativeSessionBackendOptions,
} from "./codex-acpx-native-backend.js";
import { createOpenCodeNativeSessionBackend } from "./opencode-native-backend.js";
import { RunnerdAntigravityBackend } from "../drivers/antigravity/runnerd-antigravity-backend.js";
import { ClaudeInteractiveNativeBackend, type ClaudeInteractiveNativePort } from "../drivers/claude/native-interactive-backend.js";
import { OpenCodeSharedNativeBackend, type OpenCodeSharedNativePort } from "../drivers/opencode/shared-native-backend.js";

/** Explicit native headless selection; this is not the ACPX provider path. */
export function createAntigravityHeadlessBackend(options: ConstructorParameters<typeof RunnerdAntigravityBackend>[0]): NativeSessionBackend {
  return new RunnerdAntigravityBackend(options);
}

export interface NativeBackendFactoryOptions extends Omit<
  CodexNativeSessionBackendOptions,
  "transportFactory"
> {
  /** Supplied only by the server after it has claimed the exact run lease. */
  antigravityAuthority?: ConstructorParameters<typeof RunnerdAntigravityBackend>[0];
  /** Server-owned capability, supplied only after its lease and host are bound. */
  opencodeSharedAuthority?: { port: OpenCodeSharedNativePort; model: string; effort: string; version: "2.2.5" };
  /** Server-owned capability: a real launched Claude session bound to the claimed run. */
  claudeInteractiveAuthority?: { port: ClaudeInteractiveNativePort; model: string; effort: string };
  museRunnerOptions?: Omit<RunnerdMuseDriverOptions, "execution" | "dynamicTools" | "dynamicToolHandler" | "completionFeedback" | "onSpawn">;
  dotRunnerOptions?: Omit<RunnerdDotDriverOptions, "execution" | "dynamicTools" | "dynamicToolHandler" | "completionFeedback" | "onSpawn">;
  codexTransportFactory?: (context?: {
    baseInstructions?: string;
    providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
    persistedSession?: Pick<
      PersistedHarnessSession,
      | "driverSessionId"
      | "providerSessionId"
      | "providerIdentity"
      | "activeTurnId"
    >;
  }) => CodexAppServerTransport;
  acpxRuntimeDirectory?: string;
  acpxEnvironment?: NodeJS.ProcessEnv;
  acpxManagedCodexCredentialSourcePath?: string;
  acpxDynamicToolHandler?: CodexAcpxNativeSessionBackendOptions["dynamicToolHandler"];
  opencodeRuntimeDirectory?: string;
  opencodeEnvironment?: NodeJS.ProcessEnv;
  opencodeCommand?: string;
}

/**
 * Selects only provider implementations included in this release slice.
 * Persisted contracts for future providers do not make those providers
 * executable before their independently reviewed runtime ships.
 */
export function createNativeSessionBackend(
  input: NativeExecutionInput,
  options: NativeBackendFactoryOptions = {},
): NativeSessionBackend {
  if (input.schema === "paperclip.native-execution-input.v13") {
    const authority = options.claudeInteractiveAuthority, identity = authority?.port.identity;
    if (!authority || !identity || identity.runId !== input.binding.runId || identity.companyId !== input.binding.companyId || identity.issueId !== input.binding.issueId || identity.agentId !== input.binding.agentId
      || identity.sessionId !== input.session.normalizedSessionId || authority.model !== input.provider.model || authority.effort !== input.provider.effort) throw new Error("Claude interactive v13 requires an admitted server-owned native backend");
    return new ClaudeInteractiveNativeBackend(authority.port);
  }
  if (input.schema === "paperclip.native-execution-input.v12") {
    const authority = options.opencodeSharedAuthority, identity = authority?.port.identity;
    if (!authority || !identity || identity.runId !== input.binding.runId || identity.companyId !== input.binding.companyId || identity.issueId !== input.binding.issueId || identity.agentId !== input.binding.agentId || identity.sessionId !== input.session.normalizedSessionId || (options.runnerInstanceId !== undefined && authority.port.runnerInstanceId !== options.runnerInstanceId) || authority.model !== input.provider.model || authority.effort !== input.provider.effort || authority.version !== input.provider.cliVersion) throw new Error("OpenCode shared v2 requires an admitted server-owned native backend");
    return new OpenCodeSharedNativeBackend(authority.port);
  }
  if (input.schema === "paperclip.native-execution-input.v11") {
    const authority = options.antigravityAuthority;
    if (!authority || !authority.withAdmission || authority.identity.runId !== input.binding.runId || authority.identity.companyId !== input.binding.companyId || authority.identity.issueId !== input.binding.issueId || authority.identity.agentId !== input.binding.agentId || authority.cwd !== input.workspace.cwd || (input.session.normalizedSessionId !== null && authority.identity.sessionId !== input.session.normalizedSessionId) || authority.verifiedVersion !== input.provider.cliVersion) {
      throw new Error("Antigravity server lease authority is missing or does not match execution");
    }
    return createAntigravityHeadlessBackend(authority);
  }
  if (input.schema === "paperclip.native-execution-input.v8") {
    if (!options.museRunnerOptions) throw new Error("Muse requires an admitted broker port and Rust Runner authority");
    return new HarnessDriverBackend(new RunnerdMuseDriver({ ...options.museRunnerOptions, execution: input,
      dynamicTools: options.dynamicTools, dynamicToolHandler: options.dynamicToolHandler,
      completionFeedback: options.completionFeedback, onSpawn: options.onSpawn }));
  }
  if (input.schema === "paperclip.native-execution-input.v6") {
    if (!options.dotRunnerOptions) throw new Error("External bots require an admitted broker port and Rust Runner authority");
    return new HarnessDriverBackend(new RunnerdDotDriver({ ...options.dotRunnerOptions, execution: input,
      dynamicTools: options.dynamicTools, dynamicToolHandler: options.dynamicToolHandler,
      completionFeedback: options.completionFeedback, onSpawn: options.onSpawn }));
  }
  if (options.codexTransportFactory) {
    return createRunnerdNativeSessionBackend(input, {
      completionFeedback: options.completionFeedback,
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
      environment: options.environment,
      observability: options.observability,
      workingDirectoryAuthority: options.workingDirectoryAuthority,
      transportFactory: options.codexTransportFactory,
    });
  }
  if (input.provider.kind === "opencode") {
    if (!options.opencodeRuntimeDirectory?.trim()) {
      throw new Error(
        "OpenCode native backend requires an instance runtime directory",
      );
    }
    return createOpenCodeNativeSessionBackend(input, {
      completionFeedback: options.completionFeedback,
      runtimeDirectory: options.opencodeRuntimeDirectory,
      environment: options.opencodeEnvironment,
      command: options.opencodeCommand,
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
    });
  }
  if (input.provider.kind === "acpx") {
    if (!options.acpxRuntimeDirectory?.trim()) {
      throw new Error("ACPX backend requires an instance runtime directory");
    }
    return createAcpxNativeSessionBackend(input, {
      runtimeDirectory: options.acpxRuntimeDirectory,
      environment: options.acpxEnvironment,
      ...(input.provider.agent === "codex"
        ? {
            managedCodexCredentialSourcePath:
              options.acpxManagedCodexCredentialSourcePath,
          }
        : {}),
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.acpxDynamicToolHandler,
      completionFeedback: options.completionFeedback,
    });
  }
  if (input.provider.kind !== "codex") {
    throw new Error(
      `Native backend for ${input.provider.kind} is not included in the Codex-first runner`,
    );
  }

  return createCodexNativeSessionBackend(input, {
    completionFeedback: options.completionFeedback,
    runnerInstanceId: options.runnerInstanceId,
    onSpawn: options.onSpawn,
    dynamicTools: options.dynamicTools,
    dynamicToolHandler: options.dynamicToolHandler,
    environment: options.environment,
      observability: options.observability,
    workingDirectoryAuthority: options.workingDirectoryAuthority,
    transportFactory: options.codexTransportFactory,
  });
}
