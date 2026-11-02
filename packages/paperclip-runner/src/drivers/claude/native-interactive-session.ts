import { lstat, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { ClaudeInteractiveController, type ClaudeInteractiveLaunch, type ClaudeInteractiveOwnerAuthority, type ClaudeInteractiveOwnerJournal, type ClaudeInteractivePtyFactory, type ClaudeInteractiveStatus } from "./native-interactive-controller.js";
import { NativeOwnerCommandJournal } from "./native-owner-command-journal.js";
import { ClaudeNativePtyFactory } from "./native-pty-factory.js";
import { createClaudeInteractiveVerifier, createLocalClaudeInteractiveVerifier, type ClaudeVerifierDependencies } from "./native-interactive-verifier.js";
import { ClaudeNativeHookProcess } from "./native-hook-process.js";
import type { ClaudeNativePty } from "./native-pty-factory.js";
import { ClaudeHookEventIngress } from "./native-hook-event-ingress.js";
import type { openClaudeNativeMcpBinding } from "./claude-native-mcp-binding.js";

export interface ClaudeInteractiveSessionOptions {
  executable: string; cwd: string; sessionId: string; model: string;
  effort: ClaudeInteractiveLaunch["effort"]; autoCompactTokens?: number;
  journalDirectory: string; ownerAuthority: ClaudeInteractiveOwnerAuthority;
  home: string; claudeConfigDir?: string;
  /** Reader must be explicitly bound to this namespace by its owner. */
  sdk: { getSessionInfo: ClaudeVerifierDependencies["getSessionInfo"]; namespace: { home: string; claudeConfigDir?: string } };
  /** Receipt comes from an independently observed owned-process SDK stream. */
  ownedSdkInit?: ClaudeVerifierDependencies["ownedSdkInit"];
  /** Optional finite native helper. Its receipt is hook evidence, not SDK-init. */
  hookHelperExecutable?: string;
  /** Explicit admitted run binding; the caller retains authority over every operation. */
  mcpBinding?: Awaited<ReturnType<typeof openClaudeNativeMcpBinding>>;
  /** Dependency seams available only under NODE_ENV=test. */
  ptyFactory?: ClaudeInteractivePtyFactory;
  verifierDependencies?: ClaudeVerifierDependencies;
}

/** Owns one newly launched PTY only. Detach is final: reconnect/reattach is not implemented. */
export class ClaudeInteractiveSession {
  private constructor(private readonly controller: ClaudeInteractiveController, readonly hookStart: Awaited<ReturnType<ClaudeNativeHookProcess["bind"]>> | undefined, private readonly ingress?: ClaudeHookEventIngress, private readonly closeMcp?: () => Promise<void>) {}
  static async launch(input: ClaudeInteractiveSessionOptions): Promise<ClaudeInteractiveSession> {
    input={...input};
    if ((input.ptyFactory || input.verifierDependencies) && process.env.NODE_ENV !== "test") throw new Error("Claude interactive test seams unavailable");
    if (!isAbsolute(input.journalDirectory)) throw new Error("invalid native owner journal directory");
    const directory=resolve(input.journalDirectory);
    const stat=await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform!=="win32" && ((stat.mode & 0o077)!==0 || stat.uid!==process.getuid?.()))) throw new Error("native owner journal directory must be private and owned");
    const verifier=input.verifierDependencies
      ? createClaudeInteractiveVerifier(input.verifierDependencies)
      : createLocalClaudeInteractiveVerifier({executable:input.executable,home:input.home,claudeConfigDir:input.claudeConfigDir,sdk:input.sdk,ownedSdkInit:input.ownedSdkInit});
    if (!input.ptyFactory) {
      // The concrete PTY factory inherits this process's restricted HOME and
      // CLAUDE_CONFIG_DIR; do not claim it launched in a different namespace.
      const processHome=process.env.HOME;
      const processConfig=process.env.CLAUDE_CONFIG_DIR;
      if (!processHome || resolve(processHome)!==resolve(input.home) ||
          resolve(processConfig || resolve(processHome,".claude"))!==resolve(input.claudeConfigDir || resolve(input.home,".claude"))) throw new Error("Claude PTY namespace mismatch");
    }
    const original=input.ptyFactory ?? new ClaudeNativePtyFactory();
    if (input.hookHelperExecutable && input.ptyFactory) throw new Error("native hook requires concrete PTY factory");
    if (input.mcpBinding && input.mcpBinding.scope.nativeSessionId !== input.sessionId) {
      await input.mcpBinding.close();
      throw new Error("Claude MCP session identity mismatch");
    }
    let hook:ClaudeNativeHookProcess|undefined;
    try { hook=input.hookHelperExecutable ? await ClaudeNativeHookProcess.prepare({directory,executable:input.hookHelperExecutable}) : undefined; }
    catch (error) { await input.mcpBinding?.close(); throw error; }
    let mcpConfigPath:string|undefined;
    const closeMcp=async()=>{
      try { await input.mcpBinding?.close(); }
      finally { if (mcpConfigPath) { const path=mcpConfigPath; mcpConfigPath=undefined; await unlink(path).catch(error=>{if(error.code!=="ENOENT") throw error;}); } }
    };
    let ingress:ClaudeHookEventIngress|undefined;
    let returned=false;
    let hookStart:Awaited<ReturnType<ClaudeNativeHookProcess["bind"]>> | undefined;
    let journal: NativeOwnerCommandJournal | undefined;
    const factory: ClaudeInteractivePtyFactory={
      async start(options) {
        let launch=options;
        if (input.mcpBinding) {
          const path=join(directory,`claude-mcp-${randomBytes(16).toString("hex")}.json`);
          const file=await open(path,"wx",0o600);
          mcpConfigPath=path;
          try { await file.writeFile(JSON.stringify(input.mcpBinding.mcpConfig())); } finally { await file.close(); }
          launch={...launch,args:[...launch.args,"--mcp-config",mcpConfigPath]};
        }
        if (hook) {
          const args=[...launch.args], index=args.indexOf("--settings");
          if (index<0 || args[index+1]!=="{}") throw new Error("Claude hook settings unavailable");
          ingress=await ClaudeHookEventIngress.prepare({directory,executable:input.hookHelperExecutable!});
          const hooks:Record<string,unknown>={SessionStart:[{matcher:"startup",hooks:[{type:"command",command:hook.sessionStartCommand(),timeout:15}]}]};
          for(const event of ["UserPromptSubmit","PreToolUse","PostToolUse","PostToolUseFailure","PermissionDenied","Stop","StopFailure"]) hooks[event]=[{hooks:[{type:"command",command:ingress.hookCommand(),timeout:10}]}];
          args[index+1]=JSON.stringify({hooks});
          launch={...launch,args};
        }
        const pty=await original.start(launch);
        journal=new NativeOwnerCommandJournal({directory,sessionId:input.sessionId,processGeneration:pty.generation});
        if (hook) {
          const scope=(pty as ClaudeNativePty).launchScope;
          if (!scope || scope.pid!==pty.pid || scope.generation!==pty.generation) throw new Error("Claude hook launch scope unavailable; reconcile launched session");
          await ingress!.start({sessionId:input.sessionId,launchScope:scope});
          hookStart=await hook.bind({sessionId:input.sessionId,launchScope:scope});
        }
        return pty;
      },
    };
    const ownerJournal: ClaudeInteractiveOwnerJournal={
      begin(command) { if (!journal) throw new Error("Claude owner journal unavailable"); return journal.begin(command); },
      written(operationId) { if (!journal) throw new Error("Claude owner journal unavailable"); return journal.written(operationId); },
    };
    try {
      const controller=await ClaudeInteractiveController.launch({executable:input.executable,cwd:input.cwd,sessionId:input.sessionId,model:input.model,effort:input.effort,autoCompactTokens:input.autoCompactTokens ?? 200_000},factory,verifier,input.ownerAuthority,ownerJournal);
      returned=true;
      return new ClaudeInteractiveSession(controller,hookStart,ingress,input.mcpBinding ? closeMcp : undefined);
    } finally { try { await hook?.dispose(); } finally { if(!returned) { try { await ingress?.close(); } finally { await closeMcp(); } } } }
  }
  observe(): Promise<ClaudeInteractiveStatus> { return this.controller.observe(); }
  ownerInput(input: {operationId:string;text:string}) { return this.controller.ownerInput(input); }
  /** Stops observation without terminating the owner's process; no automatic reattach. */
  hookObservationStatus() { return this.ingress?.status() ?? {state:"unavailable",provenance:"owned-descendant-attributed",settlement:"unproven",coverage:"incomplete"} as const; }
  async hookObservations() { if(!this.ingress) throw new Error("Claude hook observations unavailable"); return this.ingress.snapshot(); }
  async detach(): Promise<void> { try { await this.controller.detach(); } finally { try { await this.ingress?.close(); } finally { await this.closeMcp?.(); } } }
}
