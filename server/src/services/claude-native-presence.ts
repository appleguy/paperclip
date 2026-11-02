import { execFile as execFileCallback } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import type { ClaudeLiveSessionRegistry } from "./native-runtime/claude-native-live-sessions.js";

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

/** A newly launched, Paperclip-owned control session. External discovery rows
 * are never converted to managed handles or accepted as launch targets. */
export interface ClaudeManagedControl {
  identity():Promise<unknown>;
  ownerInput(input:{operationId:string;text:string}):Promise<unknown>;
  interrupt(input:{operationId:string}):Promise<unknown>;
  settlement():unknown;
  capabilities():unknown;
  detach():Promise<void>;
}
/** Server-admitted run authority for a managed launch. The controller builds it with
 * `createClaudeNativeAuthority`; Runner opens the scoped MCP bridge from it. */
export interface ClaudeManagedAdmission {
  scope:{companyId:string;runId:string;taskId:string;leaseId:string;nativeSessionId:string};
  definitions():Array<Record<string,unknown>>;
  dispatch(scope:ClaudeManagedAdmission["scope"],call:any):Promise<unknown>;
  /** Releases the server-side tool authority; called on detach or when a launch fails. */
  close?():Promise<void>;
}
export interface ClaudeManagedOptions {
  /** Resolve (and fail closed on) the admitted run for a launch. Absent: launches cannot bind a run. */
  admitRun?(input:{companyId:string;actorId:string;runId:string}):Promise<ClaudeManagedAdmission>;
  resolveWorkspace(companyId:string, workspaceId:string):Promise<string | null>;
  resolveHostSettings():Promise<{claudeExecutable:string;home:string;claudeConfigDir?:string}>;
  stateDirectory:string;
  hookHelperExecutable:string;
  /** Explicit server-owned pilot settings. Never inherit another agent's model. */
  model:string;
  effort:string;
  /** When set, a run-bound start ADOPTS the executor-launched session registered here (no admission, no second launch);
   * with no live session it is refused. Detach then only drops the adoption: the executor owns the process and authority. */
  liveSessions?: ClaudeLiveSessionRegistry;
  /** Internal test seam. The production default loads Runner's concrete controller. */
  launch?: (options:Record<string,unknown>)=>Promise<ClaudeManagedControl>;
}
/** In-memory handles deliberately do not reattach after restart. An on-disk
 * exclusive reservation survives a crash and prevents retrying a launch ID. */
export class ClaudeManagedSessions {
  private sessions=new Map<string,{companyId:string;actorId:string;active:{value:boolean};control:ClaudeManagedControl;admitted?:ClaudeManagedAdmission;adopted?:{companyId:string;runId:string}}>();
  constructor(private readonly options:ClaudeManagedOptions) {}
  private async launcher(options:Record<string,unknown>):Promise<ClaudeManagedControl> {
    if(this.options.launch) return this.options.launch(options);
    const runner=await import("@paperclipai/paperclip-runner");
    const klass=(runner as unknown as {ClaudeInteractiveRunner?:{launch(input:Record<string,unknown>):Promise<ClaudeManagedControl>}}).ClaudeInteractiveRunner;
    if(!klass)throw new Error("Claude managed controller is unavailable");
    return klass.launch(options);
  }
  async start(input:{companyId:string;actorId:string;requestId:string;workspaceId:string;runId?:string}) {
    const {randomUUID,createHash}=await import("node:crypto"), {constants}=await import("node:fs"), {lstat,mkdir,open}=await import("node:fs/promises"), {join}=await import("node:path");
    if(!UUID.test(input.companyId)||!UUID.test(input.requestId)||!UUID.test(input.workspaceId)||!input.actorId)throw badRequest("Invalid managed Claude launch request");
    if(!isAbsolute(this.options.stateDirectory)||!isAbsolute(this.options.hookHelperExecutable))throw new Error("Claude managed host configuration unavailable");
    const model=this.options.model.trim(), effort=this.options.effort;
    if(!model || model.length>200 || !["low","medium","high","max"].includes(effort))throw new Error("Claude managed model and effort must be explicitly configured");
    const base=resolve(this.options.stateDirectory), stat=await lstat(base);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error("Claude managed state directory must be private and owned");
    const workspace=await this.options.resolveWorkspace(input.companyId,input.workspaceId);
    if(!workspace||!isAbsolute(workspace))throw notFound("Claude company workspace unavailable");
    // Keep the per-launch Unix socket under Darwin's 104-byte sun_path bound.
    // The full binding stays in the durable reservation, never in the path.
    const launchKey=createHash("sha256").update(`${input.companyId}\0${input.requestId}`).digest("hex").slice(0,32);
    const host=await this.options.resolveHostSettings(), dir=join(base,launchKey);
    // A repeated request id is a conflict, not a server fault; its first outcome stays authoritative.
    try { await mkdir(dir,{mode:0o700}); }
    catch (error) { if((error as NodeJS.ErrnoException).code==="EEXIST")throw conflict("Claude launch request was already used; check it instead of launching again"); throw error; }
    let admitted:ClaudeManagedAdmission|undefined;
    if(input.runId!==undefined&&this.options.liveSessions){
      // Same native session as the executor's admitted run: adopt it, never launch another.
      const live=UUID.test(input.runId)?this.options.liveSessions.get(input.companyId,input.runId):undefined;
      if(!live)throw conflict("No executor-launched Claude session is live for this run");
      const record=await open(join(dir,"launch.json"),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
      try {await record.writeFile(JSON.stringify({version:1,...input,sessionId:live.nativeSessionId,state:"adopted_executor_session"}));await record.sync();} finally {await record.close();}
      const control=live.control as ClaudeManagedControl;
      this.sessions.set(input.requestId,{companyId:input.companyId,actorId:input.actorId,active:{value:true},control,adopted:{companyId:input.companyId,runId:input.runId}});
      return {controlSessionId:input.requestId,source:"paperclip_owned_interactive",identity:await control.identity(),capabilities:control.capabilities()};
    }
    if(input.runId!==undefined){
      if(!UUID.test(input.runId)||!this.options.admitRun)throw unprocessable("Claude admitted-run authority unavailable");
      admitted=await this.options.admitRun({companyId:input.companyId,actorId:input.actorId,runId:input.runId});
    }
    let control!:ClaudeManagedControl;
    try {
      // The native session is the one the server already admitted; never invent or rebind one.
      if(admitted&&(admitted.scope.companyId!==input.companyId||admitted.scope.runId!==input.runId||!UUID.test(admitted.scope.nativeSessionId)))throw conflict("Claude admitted-run scope mismatch");
      const sessionId=admitted?.scope.nativeSessionId ?? randomUUID(), active={value:true};
      const record=await open(join(dir,"launch.json"),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600).catch(error=>{if((error as NodeJS.ErrnoException).code==="EEXIST")throw conflict("Claude launch request was already used; check it instead of launching again");throw error;});
      try {await record.writeFile(JSON.stringify({version:1,...input,sessionId,workspace:resolve(workspace),state:"launch_reserved"}));await record.sync();} finally {await record.close();}
      const directory=await open(dir,"r");try{await directory.sync();}finally{await directory.close();}
      const parent=await open(base,"r");try{await parent.sync();}finally{await parent.close();}
      const {getSessionInfo}=await import("@anthropic-ai/claude-agent-sdk");
      control=await this.launcher({executable:host.claudeExecutable,cwd:resolve(workspace),sessionId,model,effort,autoCompactTokens:200000,journalDirectory:dir,ownerAuthority:{authorize:async()=>active.value},home:host.home,claudeConfigDir:host.claudeConfigDir,sdk:{getSessionInfo,namespace:{home:host.home,claudeConfigDir:host.claudeConfigDir}},hookHelperExecutable:this.options.hookHelperExecutable,...(admitted?{mcp:{scope:admitted.scope,tools:admitted.definitions(),dispatch:admitted.dispatch}}:{})});
      this.sessions.set(input.requestId,{companyId:input.companyId,actorId:input.actorId,active,control,admitted});
    } catch (error) {
      // A failed launch must not leave admitted tool authority open.
      try { await admitted?.close?.(); } catch { /* the launch failure is the reported error */ }
      throw error;
    }
    return {controlSessionId:input.requestId,source:"paperclip_owned_interactive",identity:await control.identity(),capabilities:control.capabilities()};
  }
  private lookup(companyId:string,actorId:string,id:string) {
    const entry=this.sessions.get(id);
    if(!entry||!entry.active.value||entry.companyId!==companyId||entry.actorId!==actorId)throw notFound("Claude managed control session unavailable");
    // An adopted session is only usable while the executor still holds it live.
    if(entry.adopted&&!this.options.liveSessions?.has(entry.adopted.companyId,entry.adopted.runId)){this.sessions.delete(id);throw notFound("Claude managed control session unavailable");}
    return entry;
  }
  async read(companyId:string,actorId:string,id:string) {const e=this.lookup(companyId,actorId,id);return {controlSessionId:id,source:"paperclip_owned_interactive",identity:await e.control.identity(),capabilities:e.control.capabilities(),settlement:e.control.settlement()};}
  async input(companyId:string,actorId:string,id:string,operationId:string,text:string) {return this.lookup(companyId,actorId,id).control.ownerInput({operationId,text});}
  async interrupt(companyId:string,actorId:string,id:string,operationId:string) {return this.lookup(companyId,actorId,id).control.interrupt({operationId});}
  async detach(companyId:string,actorId:string,id:string) {const e=this.lookup(companyId,actorId,id);if(e.adopted){this.sessions.delete(id);return {detached:true,ownerProcess:"retained",executorSession:"retained"};}e.active.value=false;try{await e.control.detach();}finally{this.sessions.delete(id);await e.admitted?.close?.();}return {detached:true,ownerProcess:"retained"};}
}
