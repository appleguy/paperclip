export { execute, ensureCodexSkillsInjected } from "./execute.js";
export {
  resolveCodexAuthPrecedence,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING,
  CODEX_SANDBOX_AUTH_PRECEDENCE_WARNING_LOG_LINE,
  CODEX_SANDBOX_AUTH_EXISTS_COMMAND,
  type CodexAuthPrecedenceInput,
  type CodexAuthPrecedenceResolution,
  type CodexAuthPrecedenceWinner,
} from "./auth-precedence.js";
export * from "./acp.js";
export { getConfigSchema } from "./config-schema.js";
export {
  reconcileManagedCodexHome,
  isManagedCodexHomePath,
  resolveManagedCodexHomeDir,
  evaluateCodexCredentialReadiness,
  type ReconcileManagedCodexHomeInput,
  type ReconcileManagedCodexHomeResult,
  type ReconcileManagedCodexHomeStatus,
  type CodexCredentialReadiness,
  type CodexCredentialReadinessInput,
  type CodexCredentialAuthMode,
} from "./codex-home.js";
export { listCodexSkills, syncCodexSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  runDeviceLogin,
  CODEX_DEVICE_LOGIN_COMMAND,
  type SandboxLoginDriver,
  type DeviceLoginPromptSink,
  type DeviceLoginOutcome,
  type DeviceLoginResult,
  type RunDeviceLoginOptions,
} from "./device-login-runner.js";
export { DEVICE_LOGIN_URL, parseDeviceLoginPrompt, type DeviceLoginPrompt } from "./device-login-parse.js";
export {
  promoteDeviceLoginCredential,
  checkStagedCredentialReadiness,
  DeviceLoginReadinessError,
  type CredentialReadinessResult,
  type PromoteDeviceLoginCredentialInput,
  type PromoteDeviceLoginCredentialOutcome,
  type PromoteDeviceLoginCredentialResult,
} from "./adapter-auth-promotion.js";
export {
  withCodexAccountHomePromotionLock,
  withAccountHomeSecretMutationLock,
  assertAccountHomeCacheDirStillValid,
  resolveCodexAuthCacheDir,
  isCodexAuthCachePath,
  readSubscriptionAccountId,
} from "./codex-auth-cache.js";
export { parseCodexJsonl, isCodexHarnessCrash, isCodexProviderQuotaError, isCodexTransientUpstreamError, isCodexUnknownSessionError } from "./parse.js";
export {
  getQuotaWindows,
  readCodexAuthInfo,
  readCodexToken,
  fetchCodexQuota,
  fetchCodexRpcQuota,
  mapCodexRpcQuota,
  secondsToWindowLabel,
  fetchWithTimeout,
  codexHomeDir,
} from "./quota.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as acpxSessionCodec } from "@paperclipai/adapter-utils/acpx-engine/session-codec";
import { copyCodexIssueScope } from "./issue-session-scope.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) {
      const params = acpxSessionCodec.deserialize(raw);
      return params ? copyCodexIssueScope(params, record) : null;
    }
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return copyCodexIssueScope({
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    }, record);
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) {
      const serialized = acpxSessionCodec.serialize(params);
      return serialized ? copyCodexIssueScope(serialized, params) : null;
    }
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return copyCodexIssueScope({
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    }, params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id) ??
      acpxSessionCodec.getDisplayId?.(params) ??
      null
    );
  },
};

export { decideCodexAuthMerge } from "./codex-auth-merge-decision.js";

export { copyBackCodexAuth } from "./codex-auth-copyback.js";
export * from "./rc-guard.js";
