import { isAbsolute, resolve } from "node:path";

/** Metadata projection for an authenticated, already-running Claude hook ingress.
 * Does not install hooks, read transcripts, inject PTY input or correlate dispatches. */
export interface ClaudeInteractiveIdentity { sessionId: string; cwd: string; processGeneration: string; }
export interface ClaudeInteractiveReceipt {
  sessionId: string;
  event: "SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure" | "SessionEnd" | "PermissionRequest";
  origin: "unknown";
  dispatchCorrelation: "unknown";
  runCompletion: "unproven";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const events = new Set<ClaudeInteractiveReceipt["event"]>(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "PermissionRequest"]);
const maxBytes = 256 * 1024;
export class ClaudeInteractiveReceiptFence {
  private readonly identity: Readonly<ClaudeInteractiveIdentity>;
  constructor(identity: ClaudeInteractiveIdentity) {
    if (!uuid.test(identity.sessionId) || !isAbsolute(identity.cwd) || !identity.processGeneration || identity.processGeneration.length > 1024) throw new Error("invalid Claude interactive identity");
    this.identity = Object.freeze({...identity,cwd:resolve(identity.cwd)});
  }
  /** Ingress must separately authenticate the sender and verify process birth;
   * an untrusted hook payload cannot establish either property. */
  project(json: string, verifiedProcessGeneration: string): ClaudeInteractiveReceipt {
    if (verifiedProcessGeneration !== this.identity.processGeneration) throw new Error("Claude interactive process generation changed");
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("Claude interactive hook too large");
    let data: unknown;
    try { data = JSON.parse(json); } catch { throw new Error("invalid Claude interactive hook JSON"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid Claude interactive hook payload");
    const value = data as Record<string,unknown>;
    if (value.session_id !== this.identity.sessionId || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || resolve(value.cwd) !== this.identity.cwd) throw new Error("Claude interactive hook identity mismatch");
    if (typeof value.hook_event_name !== "string" || !events.has(value.hook_event_name as ClaudeInteractiveReceipt["event"])) throw new Error("unsupported Claude interactive hook");
    return {sessionId:this.identity.sessionId,event:value.hook_event_name as ClaudeInteractiveReceipt["event"],origin:"unknown",dispatchCorrelation:"unknown",runCompletion:"unproven"};
  }
}
