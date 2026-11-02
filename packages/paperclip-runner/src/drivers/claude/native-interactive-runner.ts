import { ClaudeInteractiveSession, type ClaudeInteractiveSessionOptions } from "./native-interactive-session.js";
import { HarnessCapabilityUnavailableError } from "../../contracts/harness-driver.js";
import { openClaudeNativeMcpBinding, type ClaudeNativeMcpScope } from "./claude-native-mcp-binding.js";
import type { RunnerToolCall } from "../runner-tool-bridge.js";

/** Concrete opt-in Runner-facing controller for a newly owned native PTY.
 * It is intentionally not a HarnessDriver: the PTY has no authenticated
 * per-turn events or terminal correlation, so startTurn cannot satisfy PRP. */
export type ClaudeInteractiveRunnerOptions = Omit<ClaudeInteractiveSessionOptions,"ptyFactory"|"verifierDependencies"|"ownedSdkInit"|"hookHelperExecutable"|"mcpBinding"> & {
  hookHelperExecutable:string;
  /** Scoped task tools for one server-admitted run. The server dispatcher owns lease checks and durable receipts;
   * `scope.nativeSessionId` must equal `sessionId`. Absent: the session exposes no Paperclip tools. */
  mcp?:{scope:ClaudeNativeMcpScope;tools:readonly Readonly<Record<string,unknown>>[];dispatch:(scope:ClaudeNativeMcpScope,call:RunnerToolCall)=>Promise<unknown>};
};
export class ClaudeInteractiveRunner {
  private queue:Promise<void>=Promise.resolve();
  private detached=false;
  private constructor(private readonly session:ClaudeInteractiveSession,private readonly sessionId:string,private readonly toolsBound:boolean) {}
  static async launch(options:ClaudeInteractiveRunnerOptions):Promise<ClaudeInteractiveRunner> {
    if (!options.hookHelperExecutable) throw new Error("Claude native hook helper required");
    const {mcp,...rest}=options;
    // The binding is handed to (and closed by) the session; a failure before that closes it here.
    const mcpBinding=mcp ? await openClaudeNativeMcpBinding(mcp) : undefined;
    let session:ClaudeInteractiveSession;
    try { session=await ClaudeInteractiveSession.launch({...rest,mcpBinding,ownedSdkInit:undefined}); }
    catch (error) { await mcpBinding?.close().catch(()=>{}); throw error; }
    if (!session.hookStart || session.hookStart.sessionId!==options.sessionId || session.hookStart.event!=="SessionStart" || session.hookStart.peer!=="darwin-kernel-pid-uid-and-live-ancestry" || session.hookStart.namespace!=="parent-attested-launch-scope") {
      await session.detach().catch(()=>{});
      throw new Error("Claude native hook identity unavailable; reconcile owned session");
    }
    return new ClaudeInteractiveRunner(session,options.sessionId,mcpBinding!==undefined);
  }
  private exclusive<T>(fn:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(async()=>{if(this.detached)throw new Error("Claude interactive Runner detached");return fn();});
    this.queue=next.then(()=>undefined,()=>undefined);return next;
  }
  async identity() {
    return this.exclusive(async()=>{
      const status=await this.session.observe(), hook=this.session.hookStart!;
      if(status.nativeSessionId!==this.sessionId || hook.sessionId!==this.sessionId) throw new Error("Claude interactive identity changed");
      return {nativeSessionId:status.nativeSessionId,processGeneration:status.processGeneration,sessionBinding:status.identity,hook:{event:hook.event,peer:hook.peer,namespace:hook.namespace},remoteControl:status.remoteControl} as const;
    });
  }
  ownerInput(input:{operationId:string;text:string}) {return this.exclusive(()=>this.session.ownerInput(input));}
  /** Ctrl-C is a terminal write, not proof the provider accepted interruption. */
  async interrupt(input:{operationId:string}) {
    const result=await this.exclusive(()=>this.session.ownerInput({operationId:input.operationId,text:"\u0003"}));
    return {...result,interrupt:"attempted" as const,settlement:"unproven" as const};
  }
  /** No turn-specific receipt exists in this interface, including after Ctrl-C. */
  settlement() {return {state:"unproven",reason:"no_authenticated_turn_terminal"} as const;}
  capabilities() {return {ownerInput:"durable_write_attempt",interrupt:"terminal_write_attempt",settlement:"unsupported",managedTurns:"unsupported",reconnect:"unsupported",remoteControlPairing:"unverified",tools:this.toolsBound?"scoped_admitted_run":"disabled"} as const;}
  async startTurn():Promise<never> {throw new HarnessCapabilityUnavailableError("startTurn","interactive Claude has no authenticated PRP turn settlement");}
  async detach():Promise<void> {
    await this.exclusive(async()=>{await this.session.detach();this.detached=true;});
  }
}
