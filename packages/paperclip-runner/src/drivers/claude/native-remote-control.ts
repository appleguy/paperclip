import { isAbsolute, resolve } from "node:path";

/**
 * Read-only Claude Code session reader. The shape is intentionally compatible
 * with the vendor Agent SDK getSessionInfo/getSessionMessages functions.
 * No `query`, process launch, remote-control migration, or provider mutation.
 * https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages
 * https://code.claude.com/docs/en/remote-control
 */
export interface ClaudeSessionReader {
  getSessionInfo(sessionId: string, options: {dir: string}): Promise<{sessionId: string; cwd?: string} | undefined>;
  getSessionMessages(sessionId: string, options: {dir: string; offset: number; limit: number; includeSystemMessages: boolean}): Promise<ReadonlyArray<{
    type: "user" | "assistant" | "system"; uuid: string; session_id: string; message: unknown;
    parent_tool_use_id: string | null; parent_agent_id: string | null;
  }>>;
}
export interface ClaudeNativeSessionBinding {
  companyId: string;
  issueId: string;
  agentId: string;
  taskSessionId: string;
  runId: string;
  nativeSessionId: string;
  workspace: string;
  /** Independently verified process birth/generation, not a title or URL. */
  nativeProcessGeneration: string;
}
export interface ClaudeNativeObservationCursor { offset: number; previousMessageId: string | null; }
export interface ClaudeNativeMessage {
  sourceMessageId: string;
  nativeSessionId: string;
  role: "user" | "assistant" | "system";
  /** Transcript role alone does not identify the person or client who sent it. */
  origin: "unknown";
  message: unknown;
  parentToolUseId: string | null;
  parentAgentId: string | null;
}
export interface ClaudeNativeObservationPage {
  messages: ClaudeNativeMessage[];
  cursor: ClaudeNativeObservationCursor;
  /** A transcript snapshot cannot establish live status, completeness, or consumption. */
  liveConnection: "unknown";
  remoteControlBinding: "independently_attested_not_provider_proven";
  delivery: "transcript_snapshot";
}
export interface ClaudeNativeAuthority {
  /** Verify current Paperclip scope, session/workspace and process/RC evidence independently. */
  verify(binding: Readonly<ClaudeNativeSessionBinding>, operation: "read" | "request_owner_action"): Promise<boolean>;
}
export interface ClaudeOwnerActionQueue {
  /** Durable idempotent Paperclip record only; reject reused IDs with different scope or content. Never send to Claude or wake a provider here. */
  record(input: {binding: Readonly<ClaudeNativeSessionBinding>; requestId: string; action: "steer" | "interrupt" | "approve" | "reject"; instruction: string}): Promise<"recorded" | "already_recorded" | "uncertain">;
}
export const claudeNativeRemoteCapabilities = Object.freeze({
  transcriptSnapshot: "sdk_documented",
  liveEventStream: "unknown",
  sameRunningSessionWriter: "unsupported_documented_surface",
  paperclipInterrupt: "unsupported_documented_surface",
  paperclipApproval: "unknown",
  paperclipResumeOfRunningRemoteSession: "unsupported_documented_surface",
  ownerRemoteControl: "vendor_documented_not_verified_by_reader",
  externalWriterExclusion: "unsupported_documented_surface",
  ownerActionQueue: "paperclip_record_only",
} as const);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const MAX_PAGE = 100;

/** An observation is not a claim that Paperclip controls the native RC session. */
export class ClaudeNativeRemoteControl {
  readonly #binding: Readonly<ClaudeNativeSessionBinding>;
  constructor(binding: ClaudeNativeSessionBinding, readonly reader: ClaudeSessionReader, readonly authority: ClaudeNativeAuthority, readonly queue?: ClaudeOwnerActionQueue) {
    if (![binding.companyId,binding.issueId,binding.agentId,binding.taskSessionId,binding.runId,binding.nativeSessionId,binding.workspace,binding.nativeProcessGeneration].every(nonempty) || !uuid.test(binding.nativeSessionId) || !isAbsolute(binding.workspace)) throw new Error("invalid Claude native binding");
    this.#binding = Object.freeze({...binding, workspace: resolve(binding.workspace)});
  }
  async #check(operation: "read" | "request_owner_action"): Promise<void> {
    if (!await this.authority.verify(this.#binding, operation)) throw new Error("Claude native session authority denied");
    const info = await this.reader.getSessionInfo(this.#binding.nativeSessionId, {dir:this.#binding.workspace});
    if (!info || info.sessionId !== this.#binding.nativeSessionId || !info.cwd || !isAbsolute(info.cwd) || resolve(info.cwd) !== this.#binding.workspace) throw new Error("Claude native session identity mismatch");
    if (!await this.authority.verify(this.#binding, operation)) throw new Error("Claude native session authority changed");
  }
  async readPage(cursor: ClaudeNativeObservationCursor = {offset:0,previousMessageId:null}, limit = 50): Promise<ClaudeNativeObservationPage> {
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE ||
        (cursor.offset === 0 ? cursor.previousMessageId !== null : !nonempty(cursor.previousMessageId))) throw new Error("invalid Claude observation cursor");
    await this.#check("read");
    const options = {dir:this.#binding.workspace, includeSystemMessages:true};
    if (cursor.offset > 0) {
      const previous = await this.reader.getSessionMessages(this.#binding.nativeSessionId, {...options,offset:cursor.offset-1,limit:1});
      if (previous.length !== 1 || previous[0]?.session_id !== this.#binding.nativeSessionId || previous[0]?.uuid !== cursor.previousMessageId) throw new Error("Claude transcript changed; restart observation from a reconciled cursor");
    }
    const page = await this.reader.getSessionMessages(this.#binding.nativeSessionId, {...options,offset:cursor.offset,limit});
    if (page.length > limit) throw new Error("Claude session reader exceeded page limit");
    const ids = new Set<string>();
    const messages = page.map(row => {
      if (row.session_id !== this.#binding.nativeSessionId || !nonempty(row.uuid) || ids.has(row.uuid) || !["user","assistant","system"].includes(row.type)) throw new Error("invalid or foreign Claude transcript message");
      ids.add(row.uuid);
      return {sourceMessageId:row.uuid,nativeSessionId:row.session_id,role:row.type,origin:"unknown" as const,message:row.message,parentToolUseId:row.parent_tool_use_id,parentAgentId:row.parent_agent_id};
    });
    await this.#check("read");
    return {messages,cursor:{offset:cursor.offset+messages.length,previousMessageId:messages.at(-1)?.sourceMessageId ?? cursor.previousMessageId},liveConnection:"unknown",remoteControlBinding:"independently_attested_not_provider_proven",delivery:"transcript_snapshot"};
  }
  /** Record a request for the person; this never signals or controls the provider. */
  async requestOwnerAction(input: {requestId:string; action:"steer"|"interrupt"|"approve"|"reject"; instruction:string}): Promise<{status:"owner_action_requested"|"already_recorded"; providerActionPerformed:false}> {
    if (!this.queue) throw new Error("Claude owner action queue unavailable");
    if (!nonempty(input.requestId) || input.requestId.length > 128 || !nonempty(input.instruction) || input.instruction.length > 4000 || !["steer","interrupt","approve","reject"].includes(input.action)) throw new Error("invalid owner action request");
    await this.#check("request_owner_action");
    const outcome = await this.queue.record({...input,binding:this.#binding});
    if (outcome === "uncertain") throw new Error("owner action record uncertain; reconcile before retry");
    if (outcome !== "recorded" && outcome !== "already_recorded") throw new Error("invalid owner action record result");
    return {status:outcome === "recorded" ? "owner_action_requested" : "already_recorded",providerActionPerformed:false};
  }
}
