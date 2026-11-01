import { ClaudeNativePtyFactory } from "./native-pty-factory.js";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";

/** Provider-owned PTY implementation. Implementations must not start a model
 * until a user submits input and must retain the process birth identity. */
export interface ClaudeInteractivePty {
  readonly pid: number;
  readonly generation: string;
  /** Close observation only; leave the interactive process and owner access live. */
  detach(): Promise<void>;
  /** Terminate only this exact PTY child, never a process looked up by name. */
  stop(): Promise<void>;
  /** Terminal bytes only; no provider acknowledgment or turn attribution. */
  writeInput?(text: string): void;
}
export interface ClaudeInteractiveOwnerAuthority { authorize(): Promise<boolean>; }
export interface ClaudeInteractiveOwnerJournal {
  /** Atomically reserve an operation for this scope; reject reused IDs with changed input. */
  begin(input:{operationId:string;sessionId:string;processGeneration:string;inputSha256:string}):Promise<"reserved"|"existing"|"uncertain">;
  /** Record only that a write was attempted, never provider delivery. */
  written(operationId:string):Promise<void>;
}
export class ClaudeInteractiveInputUncertainError extends Error {
  constructor() { super("Claude terminal input outcome uncertain; reconcile before retry"); this.name="ClaudeInteractiveInputUncertainError"; }
}
export interface ClaudeInteractivePtyFactory {
  start(input: { executable: string; cwd: string; args: readonly string[] }): Promise<ClaudeInteractivePty>;
}
export interface ClaudeInteractiveVerifier {
  /** Checks actual PID and process birth, not only an inventory row. */
  process(pid: number, generation: string): Promise<boolean>;
  /** Supported SDK getSessionInfo for this exact cwd; undefined means provisional. */
  session(id: string, cwd: string): Promise<{sessionId:string;cwd?:string}|undefined>;
  /** Independently joins this exact live process generation to the native session. */
  binding?(input:{pid:number;generation:string;sessionId:string;cwd:string}): Promise<boolean>;
}
export interface ClaudeInteractiveLaunch {
  executable: string;
  cwd: string;
  sessionId: string;
  model: string;
  effort: "low" | "medium" | "high" | "max";
  autoCompactTokens: number;
}
export type ClaudeInteractiveStatus = {
  nativeSessionId: string;
  processGeneration: string;
  identity: "verified" | "provisional";
  remoteControl: "requested_connection_unverified";
  managedDispatch: "unsupported";
  completionCorrelation: "unproven";
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeModel=/^[a-zA-Z0-9._-]{1,128}$/;

/** Opt-in no-tools, 140k-or-less qualification profile, not a full executor or HarnessDriver.
 * The PTY factory chooses an authorized environment; this boundary never copies
 * credentials, supplies prompts, or asserts the RC server accepted a connection. */
export class ClaudeInteractiveController {
  private detached=false;
  private stopAttempted=false;
  private constructor(private readonly config:ClaudeInteractiveLaunch, private readonly pty:ClaudeInteractivePty, private readonly verifier:ClaudeInteractiveVerifier, private readonly ownerAuthority?:ClaudeInteractiveOwnerAuthority, private readonly ownerJournal?:ClaudeInteractiveOwnerJournal) {}
  static async launch(input:ClaudeInteractiveLaunch, factory:ClaudeInteractivePtyFactory | undefined, verifier:ClaudeInteractiveVerifier, ownerAuthority?:ClaudeInteractiveOwnerAuthority, ownerJournal?:ClaudeInteractiveOwnerJournal):Promise<ClaudeInteractiveController> {
    if (!isAbsolute(input.executable) || !isAbsolute(input.cwd) || !uuid.test(input.sessionId) || !safeModel.test(input.model) || !["low","medium","high","max"].includes(input.effort) || !Number.isSafeInteger(input.autoCompactTokens) || input.autoCompactTokens < 100_000 || input.autoCompactTokens > 140_000) throw new Error("invalid Claude interactive launch configuration");
    const config=Object.freeze({...input,executable:resolve(input.executable),cwd:resolve(input.cwd)});
    const args=["--remote-control","--session-id",config.sessionId,"--autocompact",String(config.autoCompactTokens),"--model",config.model,"--effort",config.effort,"--setting-sources","","--settings","{}","--strict-mcp-config","--no-chrome","--tools",""];
    const pty=await (factory ?? new ClaudeNativePtyFactory()).start({executable:config.executable,cwd:config.cwd,args});
    if (!Number.isSafeInteger(pty.pid) || pty.pid <= 0 || typeof pty.generation !== "string" || !pty.generation || pty.generation.length > 1024) throw new Error("invalid Claude PTY process identity; reconcile launch before retry");
    return new ClaudeInteractiveController(config,pty,verifier,ownerAuthority,ownerJournal);
  }
  /** Explicit owner terminal input. A successful local write is not a native
   * acknowledgment, a task admission, or evidence that a turn completed. */
  async ownerInput(input:{operationId:string;text:string}):Promise<{write:"attempted";delivery:"unknown";completion:"unproven";binding:"verified"|"provisional"}> {
    const {operationId,text}=input;
    if (typeof operationId!=="string" || !operationId.trim() || operationId.length>128 || typeof text!=="string" || !text || Buffer.byteLength(text,"utf8")>65536) throw new Error("invalid Claude owner input");
    if (!this.ownerAuthority || !await this.ownerAuthority.authorize()) throw new Error("Claude owner input access denied");
    const status=await this.observe();
    if (!this.pty.writeInput || !this.ownerJournal) throw new Error("Claude PTY input or durable journal unavailable");
    if (!await this.ownerAuthority.authorize()) throw new Error("Claude owner input access changed");
    if (this.detached || this.stopAttempted || !await this.verifier.process(this.pty.pid,this.pty.generation)) throw new Error("Claude interactive process identity changed");
    let reservation:"reserved"|"existing"|"uncertain";
    try { reservation=await this.ownerJournal.begin({operationId,sessionId:this.config.sessionId,processGeneration:this.pty.generation,inputSha256:createHash("sha256").update(text,"utf8").digest("hex")}); } catch { throw new ClaudeInteractiveInputUncertainError(); }
    if (reservation!=="reserved") throw new ClaudeInteractiveInputUncertainError();
    if (this.detached || this.stopAttempted || !await this.ownerAuthority.authorize() || !await this.verifier.process(this.pty.pid,this.pty.generation)) throw new ClaudeInteractiveInputUncertainError();
    try { this.pty.writeInput(text); await this.ownerJournal.written(operationId); } catch { throw new ClaudeInteractiveInputUncertainError(); }
    return {write:"attempted",delivery:"unknown",completion:"unproven",binding:status.identity};
  }
  async observe():Promise<ClaudeInteractiveStatus> {
    if (this.detached || this.stopAttempted) throw new Error("Claude interactive controller is detached or stopping");
    if (!await this.verifier.process(this.pty.pid,this.pty.generation)) throw new Error("Claude interactive process identity changed");
    const info=await this.verifier.session(this.config.sessionId,this.config.cwd);
    if (info && (info.sessionId!==this.config.sessionId || !info.cwd || !isAbsolute(info.cwd) || resolve(info.cwd)!==this.config.cwd)) throw new Error("Claude interactive SDK identity mismatch");
    const bound=!!info && !!this.verifier.binding && await this.verifier.binding({pid:this.pty.pid,generation:this.pty.generation,sessionId:this.config.sessionId,cwd:this.config.cwd});
    if (!await this.verifier.process(this.pty.pid,this.pty.generation)) throw new Error("Claude interactive process identity changed");
    return {nativeSessionId:this.config.sessionId,processGeneration:this.pty.generation,identity:bound?"verified":"provisional",remoteControl:"requested_connection_unverified",managedDispatch:"unsupported",completionCorrelation:"unproven"};
  }
  async detach():Promise<void> {
    if (this.detached || this.stopAttempted) throw new Error("Claude interactive controller is detached or stopping");
    this.detached=true;
    await this.pty.detach();
  }
  async stopOwnedProcess():Promise<void> {
    if (this.detached || this.stopAttempted) throw new Error("Claude interactive controller is detached or stopping");
    if (!await this.verifier.process(this.pty.pid,this.pty.generation)) throw new Error("Claude interactive process identity changed");
    this.stopAttempted=true;
    await this.pty.stop();
  }
}
