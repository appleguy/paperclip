// Re-export all types from the shared adapter-utils package.
// This file is kept as a convenience shim so existing in-tree
// imports (process/, http/, heartbeat.ts) don't need rewriting.
export type {
  AdapterAgent,
  AdapterSessionManagement,
  AdapterRuntime,
  UsageSummary,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterExecutionContext,
  AdapterRuntimeToolAccess,
  AdapterRuntimeToolDelivery,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestStatus,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestContext,
  AdapterSkillSyncMode,
  AdapterSkillState,
  AdapterSkillOrigin,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
  AdapterSkillContext,
  AdapterSessionCodec,
  AdapterModel,
  NativeContextManagement,
  ResolvedSessionCompactionPolicy,
  SessionCompactionPolicy,
  ConfigFieldOption,
  ConfigFieldSchema,
  AdapterConfigSchema,
  AdapterRuntimeCommandSpec,
} from "@paperclipai/adapter-utils";

import type { ServerAdapterModule as BaseServerAdapterModule } from "@paperclipai/adapter-utils";

export type ServerAdapterModule = BaseServerAdapterModule & {
  /** Save-time checks only: no provider calls or runtime startup. */
  validateConfig?: (config: Record<string, unknown>, context?: { localCwd?: boolean }) => Promise<void> | void;
};
