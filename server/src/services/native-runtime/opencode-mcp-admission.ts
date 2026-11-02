import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { readProcessStartedAt } from "../hot-restart.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { readOpenCodeHost } from "./opencode-shared-recovery.js";

const execute = promisify(execFile);
type IncomingPeer = { sessionId: string; remoteAddress: string; remotePort: number; localAddress: string; localPort: number };

/** Called for each MCP tool request, including cached results. Metadata only
 * correlates the call: the bearer is checked by the bridge, and this verifies
 * the exact incoming TCP peer and current database lease. */
export function createOpenCodeMcpAdmission(db: Db, binding: OpenCodeSharedBinding) {
  const expected = Object.freeze({ ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) });
  return async (peer: IncomingPeer): Promise<void> => {
    if (process.platform !== "darwin" || peer.sessionId !== expected.providerSessionId || peer.remoteAddress !== "127.0.0.1" || peer.localAddress !== "127.0.0.1" || !Number.isInteger(peer.remotePort) || peer.remotePort < 1 || peer.remotePort > 65535 || !Number.isInteger(peer.localPort) || peer.localPort < 1 || peer.localPort > 65535) throw new Error("opencode_mcp_admission_denied");
    const { host } = await readOpenCodeHost(db, expected);
    const started = await readProcessStartedAt(host.pid);
    if (!started || started !== host.startedAt) throw new Error("opencode_mcp_admission_denied");
    const [{ stdout }, command, cwd] = await Promise.all([
      execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(host.pid), `-iTCP:${peer.remotePort}`, "-Fpn"], { timeout: 3000, maxBuffer: 65536 }),
      execute("/bin/ps", ["-p", String(host.pid), "-o", "comm="], { timeout: 3000, maxBuffer: 4096 }),
      execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(host.pid), "-d", "cwd", "-Fn"], { timeout: 3000, maxBuffer: 4096 }),
    ]);
    const lines = stdout.split("\n");
    if (!lines.includes(`p${host.pid}`) || !lines.includes(`n127.0.0.1:${peer.remotePort}->127.0.0.1:${peer.localPort}`) || command.stdout.trim() !== host.executable || !cwd.stdout.split("\n").includes(`n${host.workingDirectory ?? join(host.namespace, "work")}`)) throw new Error("opencode_mcp_admission_denied");
    const [after, current] = await Promise.all([readProcessStartedAt(host.pid), readOpenCodeHost(db, expected)]);
    if (!after || after !== host.startedAt || JSON.stringify(current.host) !== JSON.stringify(host)) throw new Error("opencode_mcp_admission_denied");
  };
}
