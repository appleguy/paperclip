/** Documented agy 1.4.12 headless NDJSON boundary; this is not interactive RC.
 * https://antigravity.google/docs/cli/headless/
 */
export type NativeEvent =
  | { kind: "init"; conversationId: string; cwd: string; permissionMode: string }
  | { kind: "step"; conversationId: string; index: number; state: string; stepType: string; toolName?: string; textDelta?: string }
  | { kind: "result"; conversationId: string; status: string; response?: string; numTurns?: number };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** One instance per actual stdout stream. Caller owns process and generation verification. */
export class AntigravityHeadlessStream {
  private pending = Buffer.alloc(0);
  private conversationId?: string;
  private failed = false;
  constructor(readonly cliVersion: string, readonly expectedConversationId?: string, readonly maxLineBytes = 1024 * 1024) {
    if (cliVersion !== "1.4.12") throw new Error("Unsupported agy version");
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error("Invalid line limit");
  }

  push(chunk: Buffer): NativeEvent[] {
    if (this.failed) throw new Error("Stream already failed");
    try {
      const events: NativeEvent[] = [];
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.pending.length + part.length > this.maxLineBytes) throw new Error("NDJSON line exceeds limit");
        this.pending = Buffer.concat([this.pending, part]);
        if (newline < 0) break;
        if (this.pending.length === 0) throw new Error("Empty NDJSON line");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.pending);
        this.pending = Buffer.alloc(0);
        events.push(this.parse(JSON.parse(text)));
        offset = newline + 1;
      }
      return events;
    } catch (error) { this.failed = true; throw error; }
  }

  finish(): void {
    if (this.failed || this.pending.length || !this.conversationId) throw new Error("Incomplete or failed stream");
  }

  private parse(value: unknown): NativeEvent {
    if (!object(value)) throw new Error("Invalid event");
    if (value.event === "init") {
      if (this.conversationId || !nonempty(value.conversation_id) || !object(value.init) || !nonempty(value.init.cwd) || !nonempty(value.init.permission_mode)) throw new Error("Invalid init");
      if (this.expectedConversationId && value.conversation_id !== this.expectedConversationId) throw new Error("Conversation mismatch");
      this.conversationId = value.conversation_id;
      return { kind: "init", conversationId: value.conversation_id, cwd: value.init.cwd, permissionMode: value.init.permission_mode };
    }
    if (!this.conversationId || (value.event !== "step_update" && value.event !== "result")) throw new Error("Unexpected event");
    const payload = value[value.event];
    if (!object(payload) || payload.conversation_id !== this.conversationId) throw new Error("Conversation mismatch");
    if (value.event === "step_update") {
      if (!Number.isSafeInteger(payload.step_index) || (payload.step_index as number) < 0 || !nonempty(payload.state) || !nonempty(payload.step_type)) throw new Error("Invalid step");
      return { kind: "step", conversationId: this.conversationId, index: payload.step_index as number, state: payload.state, stepType: payload.step_type, ...(typeof payload.tool_name === "string" ? { toolName: payload.tool_name } : {}), ...(typeof payload.text_delta === "string" ? { textDelta: payload.text_delta } : {}) };
    }
    if (!nonempty(payload.status)) throw new Error("Invalid result");
    return { kind: "result", conversationId: this.conversationId, status: payload.status, ...(typeof payload.response === "string" ? { response: payload.response } : {}), ...(Number.isSafeInteger(payload.num_turns) && (payload.num_turns as number) >= 0 ? { numTurns: payload.num_turns as number } : {}) };
  }
}

/** Serialize the documented stdin user message. No write or retry is performed. */
export function encodeAntigravityUserMessage(content: string): string {
  if (!content || content.startsWith("/")) throw new Error("Empty and CLI slash-command prompts are unsupported");
  return JSON.stringify({ event: "user", message: { content } }) + "\n";
}
