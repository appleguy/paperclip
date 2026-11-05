import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SCO-912: codex_local fails closed unless the turn runs in the enrolled Codex Remote Control daemon.
// The only accepted launcher is the SCO-904 shim (codex-acp-rc), which proxies codex-acp onto that daemon.
// There is no fallback to the bundled codex-acp, a per-agent codex-home, or the CLI/exec engine.
export const CODEX_RC_LAUNCHER_BASENAME = "codex-acp-rc";

export const CODEX_RC_REQUIRED_MESSAGE =
  "codex_local must run in Codex Remote Control: set engine=acp (or leave unset) and agentCommand to the codex-acp-rc shim (ops/codex-remote-control/codex-acp-rc).";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Returns why this codex_local config would run outside Remote Control, or null when it is compliant. */
export function codexRemoteControlViolation(config: Record<string, unknown>): string | null {
  const engine = str(config.engine).toLowerCase();
  if (engine === "cli") {
    return `${CODEX_RC_REQUIRED_MESSAGE} engine=cli (exec) threads are invisible to Remote Control.`;
  }
  const command = str(config.agentCommand) || str(config.acpAgentCommand);
  if (!command) {
    return `${CODEX_RC_REQUIRED_MESSAGE} agentCommand is missing, which would fall back to the bundled codex-acp.`;
  }
  const launcher = command.split(/\s+/)[0] ?? "";
  if (path.basename(launcher) !== CODEX_RC_LAUNCHER_BASENAME) {
    return `${CODEX_RC_REQUIRED_MESSAGE} agentCommand "${command}" is not the Remote Control shim.`;
  }
  return null;
}

export function codexRcDaemonSocketPath(): string {
  return path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

/** Named error when the enrolled daemon's control socket is absent, instead of degrading quietly. */
export function codexRcDaemonDownReason(socketPath = codexRcDaemonSocketPath()): string | null {
  try {
    if (fs.statSync(socketPath).isSocket()) return null;
  } catch {
    // fall through
  }
  return `Codex Remote Control daemon is not running (no control socket at ${socketPath}); start the enrolled daemon (codex remote-control start). Not falling back to a non-RC path.`;
}
