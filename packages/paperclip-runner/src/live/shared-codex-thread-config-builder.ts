import { resolve } from "node:path";
import { createRunnerdCodexAppServerArgs, trustedRuntimeReadOnlyRoots } from "./runner-provider-launch.js";
import { sharedDaemonExecutableReadRoots, sharedThreadConfigFromArgs, sharedThreadConfigViolation } from "./shared-codex-thread-config.js";

export type SharedCodexThreadConfigPolicy = Readonly<{
  /** Execution workspace; the only writable root of the writable profile. */
  cwd: string;
  readOnly: boolean;
  /** Core's selected web-search policy; "disabled" must ride in the config because shared daemon args stay empty. */
  webSearchDisabled: boolean;
  /** The admitted network setting. Admission decides it; this builder neither widens nor bans it. */
  networkAccess: boolean;
  codexHome: string;
  codexExecutable: string;
  /** Trusted command PATH; the only environment value the shell policy carries (never run-scoped credentials). */
  path: string;
  /** Server-registered run copy of instructions plus pinned instruction/skill bundle roots, all read-only. */
  instructionWorkingCopyRoot?: string;
  runtimeReadRoots?: readonly string[];
}>;

/**
 * Server-side, deterministic construction of the shared-daemon `thread/start.config`. It runs on a controlled environment
 * that holds only PATH (and the admitted network flag), so ambient credentials, Git/GitHub projections and host overrides
 * cannot reach the generated policy. The result is bound into the launch requirements digest and compared exactly by the
 * admission and by `validatePreparedRunnerLaunch`; nothing downstream regenerates or edits it.
 */
export function createSharedCodexThreadConfig(policy: SharedCodexThreadConfigPolicy): Record<string, unknown> {
  const environment: NodeJS.ProcessEnv = { PATH: policy.path };
  // Plain JSON (the TOML parser yields null-prototype objects) so every later exact comparison is representation-independent.
  const config = JSON.parse(JSON.stringify(sharedThreadConfigFromArgs(createRunnerdCodexAppServerArgs({
    environment,
    disableWebSearch: policy.webSearchDisabled,
    codexHome: policy.codexHome,
    workingDirectory: policy.cwd,
    codexCommand: policy.codexExecutable,
    instructionWorkingCopyRoot: policy.instructionWorkingCopyRoot,
    readOnlyRoots: [
      ...trustedRuntimeReadOnlyRoots(environment),
      ...sharedDaemonExecutableReadRoots(policy.codexExecutable),
      ...(policy.runtimeReadRoots ?? []).map((root) => resolve(root)),
    ],
  }))));
  // The launch environment flag would also switch the shell policy to inherit everything, so the admitted network setting is
  // applied to the profiles directly and the environment policy keeps inheriting nothing.
  for (const profile of Object.values(config.permissions as Record<string, { network: { enabled: boolean } }>)) profile.network.enabled = policy.networkAccess;
  const violation = sharedThreadConfigViolation(config, { cwd: policy.cwd, readOnly: policy.readOnly, disableWebSearch: policy.webSearchDisabled });
  if (violation) throw new Error(`shared_codex_thread_config_invalid:${violation}`);
  return config;
}
