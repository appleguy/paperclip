import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ClaudeInteractiveController, type ClaudeInteractiveLaunch, type ClaudeInteractiveOwnerAuthority, type ClaudeInteractiveOwnerJournal, type ClaudeInteractivePtyFactory, type ClaudeInteractiveStatus } from "./native-interactive-controller.js";
import { NativeOwnerCommandJournal } from "./native-owner-command-journal.js";
import { ClaudeNativePtyFactory } from "./native-pty-factory.js";
import { createClaudeInteractiveVerifier, createLocalClaudeInteractiveVerifier, type ClaudeVerifierDependencies } from "./native-interactive-verifier.js";

export interface ClaudeInteractiveSessionOptions {
  executable: string; cwd: string; sessionId: string; model: string;
  effort: ClaudeInteractiveLaunch["effort"]; autoCompactTokens?: number;
  journalDirectory: string; ownerAuthority: ClaudeInteractiveOwnerAuthority;
  home: string; claudeConfigDir?: string;
  /** Reader must be explicitly bound to this namespace by its owner. */
  sdk: { getSessionInfo: ClaudeVerifierDependencies["getSessionInfo"]; namespace: { home: string; claudeConfigDir?: string } };
  /** Receipt comes from an independently observed owned-process SDK stream. */
  ownedSdkInit?: ClaudeVerifierDependencies["ownedSdkInit"];
  /** Dependency seams available only under NODE_ENV=test. */
  ptyFactory?: ClaudeInteractivePtyFactory;
  verifierDependencies?: ClaudeVerifierDependencies;
}

/** Owns one newly launched PTY only. Detach is final: reconnect/reattach is not implemented. */
export class ClaudeInteractiveSession {
  private constructor(private readonly controller: ClaudeInteractiveController) {}
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
    let journal: NativeOwnerCommandJournal | undefined;
    const factory: ClaudeInteractivePtyFactory={
      async start(options) {
        const pty=await original.start(options);
        journal=new NativeOwnerCommandJournal({directory,sessionId:input.sessionId,processGeneration:pty.generation});
        return pty;
      },
    };
    const ownerJournal: ClaudeInteractiveOwnerJournal={
      begin(command) { if (!journal) throw new Error("Claude owner journal unavailable"); return journal.begin(command); },
      written(operationId) { if (!journal) throw new Error("Claude owner journal unavailable"); return journal.written(operationId); },
    };
    const controller=await ClaudeInteractiveController.launch({executable:input.executable,cwd:input.cwd,sessionId:input.sessionId,model:input.model,effort:input.effort,autoCompactTokens:input.autoCompactTokens ?? 140_000},factory,verifier,input.ownerAuthority,ownerJournal);
    return new ClaudeInteractiveSession(controller);
  }
  observe(): Promise<ClaudeInteractiveStatus> { return this.controller.observe(); }
  ownerInput(input: {operationId:string;text:string}) { return this.controller.ownerInput(input); }
  /** Stops observation without terminating the owner's process; no automatic reattach. */
  detach(): Promise<void> { return this.controller.detach(); }
}
