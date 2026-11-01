import { execFile as execFileCallback } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ClaudePresenceTarget { sessionId: string; workspace: string; }
export interface ClaudeInventoryRow { sessionId: string; cwd: string; pid: number; startedAt: number; kind: string; status: string; }
export interface ClaudeProcessIdentity { pid: number; startedAtMs: number; executable: string; }
/** Compatible with the documented Agent SDK getSessionInfo function. */
export interface ClaudeSessionMetadataReader { getSessionInfo(id: string, options:{dir:string}): Promise<{sessionId:string;cwd?:string}|undefined>; }
export interface ClaudePresenceDependencies {
  /** Must enforce Paperclip company/issue/agent and session read access independently. */
  authorize(target: Readonly<ClaudePresenceTarget>): Promise<boolean>;
  inventory(): Promise<unknown>;
  process(pid:number): Promise<ClaudeProcessIdentity | null>;
  sdk: ClaudeSessionMetadataReader;
}
export type ClaudeNativePresence =
  | {state:"not_listed";sessionId:string; remoteControl:"unknown"}
  | {state:"verified_local_session";sessionId:string; workspace:string; processGeneration:string; kind:string; status:string; remoteControl:"unknown"; ownerIntervention:"unrestricted_by_observer"};
function validRow(value: unknown): value is ClaudeInventoryRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sessionId === "string" && UUID.test(row.sessionId) && typeof row.cwd === "string" && isAbsolute(row.cwd) &&
    typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.startedAt === "number" && Number.isFinite(row.startedAt) && row.startedAt > 0 &&
    typeof row.kind === "string" && row.kind.length <= 64 && typeof row.status === "string" && row.status.length <= 64;
}
function matchTarget(raw: unknown, target: ClaudePresenceTarget): ClaudeInventoryRow | null {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("invalid Claude session inventory");
  const matching = raw.filter((value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).sessionId === target.sessionId);
  if (matching.length === 0) return null;
  if (matching.length !== 1 || !validRow(matching[0]) || resolve(matching[0].cwd) !== target.workspace) throw new Error("ambiguous Claude session identity");
  return matching[0];
}
function sameProcess(row: ClaudeInventoryRow, process: ClaudeProcessIdentity | null): process is ClaudeProcessIdentity {
  const startedAt = row.startedAt < 100_000_000_000 ? row.startedAt * 1000 : row.startedAt;
  return process !== null && process.pid === row.pid && basename(process.executable) === "claude" &&
    Number.isFinite(process.startedAtMs) && Math.abs(startedAt - process.startedAtMs) <= 3000;
}
/** Read-only observation; never starts, attaches to, or sends input to Claude. */
export async function inspectClaudeNativePresence(targetInput: ClaudePresenceTarget, deps: ClaudePresenceDependencies): Promise<ClaudeNativePresence> {
  if (!UUID.test(targetInput.sessionId) || !isAbsolute(targetInput.workspace)) throw new Error("invalid Claude presence target");
  const target = Object.freeze({sessionId:targetInput.sessionId, workspace:resolve(targetInput.workspace)});
  if (!await deps.authorize(target)) throw new Error("Claude presence access denied");
  const first = matchTarget(await deps.inventory(),target);
  if (!first) {
    if (!await deps.authorize(target)) throw new Error("Claude presence access changed");
    return {state:"not_listed",sessionId:target.sessionId,remoteControl:"unknown"};
  }
  const processBefore = await deps.process(first.pid);
  if (!sameProcess(first,processBefore)) throw new Error("Claude process identity unverified");
  const info = await deps.sdk.getSessionInfo(target.sessionId,{dir:target.workspace});
  if (!info || info.sessionId !== target.sessionId || !info.cwd || !isAbsolute(info.cwd) || resolve(info.cwd) !== target.workspace) throw new Error("Claude SDK session identity mismatch");
  const second = matchTarget(await deps.inventory(),target);
  const processAfter = await deps.process(first.pid);
  if (!second || second.pid !== first.pid || second.startedAt !== first.startedAt || second.kind !== first.kind || !sameProcess(second,processAfter) || processAfter.startedAtMs !== processBefore.startedAtMs) throw new Error("Claude session changed during inspection");
  if (!await deps.authorize(target)) throw new Error("Claude presence access changed");
  const kind = ["interactive","background"].includes(second.kind) ? second.kind : "unknown";
  const status = ["idle","running","completed","failed","stopped"].includes(second.status) ? second.status : "unknown";
  return {state:"verified_local_session",sessionId:target.sessionId,workspace:target.workspace,processGeneration:`${first.pid}:${processAfter.startedAtMs}`,kind,status,remoteControl:"unknown",ownerIntervention:"unrestricted_by_observer"};
}

/** Host implementation of the two read-only system probes, with no transcript or credential output. */
export function createClaudeNativeLocalProbes(options: {claudeExecutable:string; home:string; claudeConfigDir?:string}): Pick<ClaudePresenceDependencies,"inventory"|"process"> {
  if (!isAbsolute(options.claudeExecutable) || !isAbsolute(options.home) || (options.claudeConfigDir !== undefined && !isAbsolute(options.claudeConfigDir))) throw new Error("invalid Claude local probe configuration");
  const env: NodeJS.ProcessEnv = {HOME:options.home, PATH:"/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL:"C", ...(options.claudeConfigDir ? {CLAUDE_CONFIG_DIR:options.claudeConfigDir} : {})};
  return {
    async inventory() {
      let stdout: string;
      try { ({stdout} = await execFile(options.claudeExecutable,["agents","--json"],{env,timeout:5000,maxBuffer:1024*1024,encoding:"utf8"})); }
      catch { throw new Error("Claude session inventory unavailable"); }
      try { return JSON.parse(stdout); } catch { throw new Error("invalid Claude session inventory JSON"); }
    },
    async process(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try {
        const [command, start] = await Promise.all([
          execFile("/bin/ps",["-p",String(pid),"-o","comm="],{env,timeout:3000,maxBuffer:4096,encoding:"utf8"}),
          execFile("/bin/ps",["-p",String(pid),"-o","lstart="],{env,timeout:3000,maxBuffer:4096,encoding:"utf8"}),
        ]);
        const startedAtMs = Date.parse(start.stdout.trim());
        return Number.isFinite(startedAtMs) ? {pid,startedAtMs,executable:command.stdout.trim()} : null;
      } catch { return null; }
    },
  };
}

export interface ClaudeExternalDiscovery {
  sessions: Array<{sessionId:string;source:"observed_external";kind:string;status:string;remoteControl:"unknown"; ownerIntervention:"vendor_native_unverified"}>;
  truncated: boolean;
}
/** Board-only caller; inventory is bounded and each identity is independently rechecked. */
export async function discoverClaudeNativePresence(deps: Omit<ClaudePresenceDependencies,"authorize"> & {authorize(): Promise<boolean>; shouldContinue?: () => boolean}): Promise<ClaudeExternalDiscovery> {
  const checkDeadline = () => { if (deps.shouldContinue && !deps.shouldContinue()) throw new Error("Claude discovery deadline exceeded"); };
  checkDeadline();
  if (!await deps.authorize()) throw new Error("Claude presence access denied");
  const raw = await deps.inventory();
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error("invalid Claude session inventory");
  const counts = new Map<string,number>();
  for (const value of raw) if (validRow(value)) counts.set(value.sessionId,(counts.get(value.sessionId) ?? 0)+1);
  const candidates = raw.filter(validRow).filter(row => counts.get(row.sessionId) === 1).slice(0,64);
  const truncated = raw.length > 64;
  // One first and one later inventory per request; avoid spawning a CLI per row.
  const firstChecks: Array<{row:ClaudeInventoryRow;process:ClaudeProcessIdentity} | null> = [];
  for (let offset = 0; offset < candidates.length; offset += 4) {
    checkDeadline();
    const batch = await Promise.all(candidates.slice(offset,offset+4).map(async row => {
      try {
        const process = await deps.process(row.pid);
        if (!sameProcess(row,process)) return null;
        const info = await deps.sdk.getSessionInfo(row.sessionId,{dir:resolve(row.cwd)});
        return info && info.sessionId === row.sessionId && info.cwd && isAbsolute(info.cwd) && resolve(info.cwd) === resolve(row.cwd) ? {row,process} : null;
      } catch { return null; }
    }));
    firstChecks.push(...batch);
  }
  checkDeadline();
  const later = await deps.inventory();
  if (!Array.isArray(later) || later.length > 1000) throw new Error("invalid Claude session inventory");
  const result: ClaudeExternalDiscovery["sessions"] = [];
  for (const checked of firstChecks) {
    checkDeadline();
    if (!checked) continue;
    try {
      const target = {sessionId:checked.row.sessionId,workspace:resolve(checked.row.cwd)};
      const row = matchTarget(later,target);
      if (!row || row.pid !== checked.row.pid || row.startedAt !== checked.row.startedAt || row.kind !== checked.row.kind) continue;
      const process = await deps.process(row.pid);
      if (!sameProcess(row,process) || process.startedAtMs !== checked.process.startedAtMs) continue;
      result.push({sessionId:row.sessionId,source:"observed_external",kind:["interactive","background"].includes(row.kind) ? row.kind : "unknown",status:["idle","running","completed","failed","stopped"].includes(row.status) ? row.status : "unknown",remoteControl:"unknown",ownerIntervention:"vendor_native_unverified"});
    } catch { /* a vanished or changed session is not an identity match */ }
  }
  if (!await deps.authorize()) throw new Error("Claude presence access changed");
  return {sessions:result,truncated};
}
