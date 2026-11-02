import { isAbsolute, resolve } from "node:path";

/** Validates the documented SDK stream from one already-owned process. It does
 * not launch, attach, enable Remote Control, or confer write authority. */
export interface ClaudeSdkExpectedIdentity {
  sessionId: string;
  cwd: string;
  cliVersion: string;
  model: string;
  processGeneration: string;
}
export type ClaudeSdkStreamObservation =
  | { kind: "initialized"; sessionId: string; capabilities: string[] }
  | { kind: "input_replayed"; sessionId: string; messageId: string }
  | { kind: "result"; sessionId: string; messageId: string; resultIndex: number | null }
  | { kind: "event"; sessionId: string; eventType: string; messageId: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 1024;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export class ClaudeSdkIdentityFence {
  private initialized = false;
  private closed = false;
  private readonly expected: Readonly<ClaudeSdkExpectedIdentity>;
  constructor(identity: ClaudeSdkExpectedIdentity) {
    if (!uuid.test(identity.sessionId) || !isAbsolute(identity.cwd) || !text(identity.cliVersion) || !text(identity.model) || !text(identity.processGeneration)) throw new Error("invalid Claude SDK identity");
    this.expected = Object.freeze({ ...identity, cwd: resolve(identity.cwd) });
  }
  /** Caller must independently verify the process generation each time. */
  accept(value: unknown, processGeneration: string): ClaudeSdkStreamObservation {
    if (this.closed || processGeneration !== this.expected.processGeneration) throw new Error("Claude SDK generation changed or stream closed");
    if (!object(value) || !text(value.type) || value.session_id !== this.expected.sessionId) throw new Error("foreign or malformed Claude SDK event");
    if (!this.initialized) {
      if (value.type !== "system" || value.subtype !== "init" || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || resolve(value.cwd) !== this.expected.cwd || value.claude_code_version !== this.expected.cliVersion || value.model !== this.expected.model) throw new Error("Claude SDK initialization identity mismatch");
      if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.length > 256 || !value.capabilities.every(text))) throw new Error("invalid Claude SDK capabilities");
      this.initialized = true;
      return { kind: "initialized", sessionId: this.expected.sessionId, capabilities: [...(value.capabilities as string[] | undefined ?? [])] };
    }
    if (value.type === "system" && value.subtype === "init") throw new Error("duplicate Claude SDK initialization");
    const messageId = value.uuid;
    if (messageId !== undefined && (typeof messageId !== "string" || !uuid.test(messageId))) throw new Error("invalid Claude SDK message id");
    if (value.type === "user" && value.isReplay === true) {
      if (typeof messageId !== "string") throw new Error("Claude SDK replay lacks message id");
      return { kind: "input_replayed", sessionId: this.expected.sessionId, messageId };
    }
    if (value.type === "result") {
      if (typeof messageId !== "string" || (value.result_index !== undefined && (!Number.isSafeInteger(value.result_index) || (value.result_index as number) < 0))) throw new Error("invalid Claude SDK result");
      return { kind: "result", sessionId: this.expected.sessionId, messageId, resultIndex: (value.result_index as number | undefined) ?? null };
    }
    return { kind: "event", sessionId: this.expected.sessionId, eventType: value.type, messageId: typeof messageId === "string" ? messageId : null };
  }
  /** In-flight sends remain uncertain; a disconnect is not a retry permit. */
  disconnect(): { pendingDelivery: "unknown"; remoteControl: "unverified" } {
    this.closed = true;
    return { pendingDelivery: "unknown", remoteControl: "unverified" };
  }
}
