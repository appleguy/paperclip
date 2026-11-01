import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import type { ClaudeInteractiveVerifier } from "./native-interactive-controller.js";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ProcessIdentity = { pid: number; generation: string; executable: string; startedAtMs: number };
type NativeSessionInfo = { sessionId: string; cwd?: string };
/** Only use a receipt captured directly from the exact owned process's SDK init stream. */
export type ClaudeOwnedSdkInit = { source: "owned-sdk-init"; pid: number; generation: string; sessionId: string; cwd: string };
export interface ClaudeVerifierDependencies {
  /** Exact executable identity, canonicalized by the production local probe. */
  executable: string;
  /** Pass the actual @anthropic-ai/claude-agent-sdk getSessionInfo export. */
  getSessionInfo(id: string, options: { dir: string }): Promise<NativeSessionInfo | undefined>;
  inventory(): Promise<unknown>;
  process(pid: number): Promise<ProcessIdentity | null>;
  ownedSdkInit?(pid: number, generation: string): Promise<ClaudeOwnedSdkInit | null>;
}
const samePath = (a: unknown, b: string): boolean => typeof a === "string" && isAbsolute(a) && resolve(a) === b;
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error("Claude verifier lookup timeout")), ms);
    promise.then(v => { clearTimeout(timer); resolveValue(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
function matchingRow(raw: unknown, sessionId: string, cwd: string, pid: number, startedAtMs: number): boolean {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("invalid Claude session inventory");
  const rows = raw.filter(value => value && typeof value === "object" && !Array.isArray(value) && value.sessionId === sessionId);
  if (!rows.length) return false;
  if (rows.length !== 1) throw new Error("ambiguous Claude session inventory");
  const row = rows[0] as Record<string, unknown>;
  if (!samePath(row.cwd,cwd) || row.pid !== pid || typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt)) throw new Error("Claude session inventory identity mismatch");
  const time = row.startedAt < 100_000_000_000 ? row.startedAt * 1000 : row.startedAt;
  if (Math.abs(time - startedAtMs) > 3000) throw new Error("Claude session process generation mismatch");
  return true;
}
/** Read-only verifier; native inventory correlation alone remains provisional. */
export function createClaudeInteractiveVerifier(deps: ClaudeVerifierDependencies, timeoutMs = 5000): ClaudeInteractiveVerifier {
  if (!isAbsolute(deps.executable)) throw new Error("invalid Claude executable identity");
  const expectedExecutable=resolve(deps.executable);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("invalid Claude verifier timeout");
  const getInfo = deps.getSessionInfo.bind(deps), inventory = deps.inventory.bind(deps), process = deps.process.bind(deps), init = deps.ownedSdkInit?.bind(deps);
  const readInfo = async (id: string, cwd: string) => {
    try { return await deadline(getInfo(id,{dir:cwd}),timeoutMs); }
    catch { throw new Error("Claude SDK session metadata unavailable"); }
  };
  const checkProcess = async (pid: number, generation: string) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof generation !== "string" || !generation || generation.length > 1024) return null;
    const value = await deadline(process(pid),timeoutMs);
    return value && value.pid === pid && value.generation === generation && isAbsolute(value.executable) && resolve(value.executable) === expectedExecutable && Number.isFinite(value.startedAtMs) ? value : null;
  };
  return {
    async process(pid,generation) { return !!await checkProcess(pid,generation); },
    async session(id,cwd) {
      if (!UUID.test(id) || !isAbsolute(cwd)) throw new Error("invalid Claude session identity");
      const info = await readInfo(id,resolve(cwd));
      if (!info) return undefined;
      if (info.sessionId !== id || !samePath(info.cwd,resolve(cwd))) throw new Error("Claude SDK session identity mismatch");
      return {sessionId:info.sessionId,cwd:resolve(info.cwd!)};
    },
    async binding(input) {
      if (!UUID.test(input.sessionId) || !isAbsolute(input.cwd)) throw new Error("invalid Claude session identity");
      const cwd=resolve(input.cwd), before=await checkProcess(input.pid,input.generation);
      if (!before) throw new Error("Claude process identity changed");
      const first=matchingRow(await deadline(inventory(),timeoutMs),input.sessionId,cwd,input.pid,before.startedAtMs);
      const info=await readInfo(input.sessionId,cwd);
      if (!info) return false;
      if (info.sessionId !== input.sessionId || !samePath(info.cwd,cwd)) throw new Error("Claude SDK session identity mismatch");
      const receipt=init ? await deadline(init(input.pid,input.generation),timeoutMs) : null;
      const second=matchingRow(await deadline(inventory(),timeoutMs),input.sessionId,cwd,input.pid,before.startedAtMs);
      const after=await checkProcess(input.pid,input.generation);
      if (!after || before.startedAtMs !== after.startedAtMs || first !== second) throw new Error("Claude session changed during inspection");
      // SDK metadata and CLI inventory have no documented independently authenticated PID binding.
      return first && second && !!receipt && receipt.source === "owned-sdk-init" && receipt.pid === input.pid && receipt.generation === input.generation && receipt.sessionId === input.sessionId && samePath(receipt.cwd,cwd);
    },
  };
}

/** Composes the documented SDK export with bounded local commands; starts no Claude session. */
export function createLocalClaudeInteractiveVerifier(input: { executable: string; home: string; claudeConfigDir?: string; sdk: {getSessionInfo: ClaudeVerifierDependencies["getSessionInfo"]; namespace: {home: string; claudeConfigDir?: string}}; ownedSdkInit?: ClaudeVerifierDependencies["ownedSdkInit"] }): ClaudeInteractiveVerifier {
  if (!isAbsolute(input.executable) || !isAbsolute(input.home) || (input.claudeConfigDir !== undefined && !isAbsolute(input.claudeConfigDir))) throw new Error("invalid Claude verifier configuration");
  // The SDK uses its own process namespace. Its reader must explicitly attest
  // the same home/config root as the CLI; we never mutate process.env.
  if (!input.sdk.namespace || !samePath(input.sdk.namespace.home,resolve(input.home)) ||
      !samePath(input.sdk.namespace.claudeConfigDir ?? resolve(input.sdk.namespace.home,".claude"),resolve(input.claudeConfigDir ?? resolve(input.home,".claude")))) throw new Error("Claude SDK namespace mismatch");
  let executable: string;
  try { executable=realpathSync(input.executable); } catch { throw new Error("Claude executable unavailable"); }
  const env: NodeJS.ProcessEnv={ HOME:resolve(input.home), PATH:"/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL:"C", ...(input.claudeConfigDir ? {CLAUDE_CONFIG_DIR:resolve(input.claudeConfigDir)} : {}) };
  return createClaudeInteractiveVerifier({
    executable, getSessionInfo: input.sdk.getSessionInfo.bind(input.sdk), ownedSdkInit: input.ownedSdkInit,
    async inventory() {
      try { const {stdout}=await exec(executable,["agents","--json"],{env,timeout:4000,maxBuffer:1024*1024,encoding:"utf8"}); return JSON.parse(stdout) as unknown; }
      catch { throw new Error("Claude session inventory unavailable"); }
    },
    async process(pid) {
      try {
        const [command,start]=await Promise.all([
          exec("/bin/ps",["-p",String(pid),"-o","comm="],{env,timeout:2000,maxBuffer:4096,encoding:"utf8"}),
          exec("/bin/ps",["-p",String(pid),"-o","lstart="],{env,timeout:2000,maxBuffer:4096,encoding:"utf8"}),
        ]);
        const birth=start.stdout.trim(), startedAtMs=Date.parse(birth);
        return Number.isFinite(startedAtMs) ? {pid,generation:`${pid}:${birth}`,executable:realpathSync(command.stdout.trim()),startedAtMs} : null;
      } catch { return null; }
    },
  });
}
