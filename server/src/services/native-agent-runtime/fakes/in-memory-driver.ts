/**
 * Tiny in-memory ProviderDriver fake for the universal conformance suite.
 *
 * It models only what the driver contract (spec section 3.2) exposes: one
 * attested host epoch, scope-keyed conversations, at-most-once submit per
 * op_id, an append-only event cursor and outcome reads. No processes, no
 * network, no model calls. The same instance is reused across a simulated
 * Paperclip restart, which is what "reattach to the live host" means.
 */

import type {
  Capabilities,
  ConvScope,
  Fence,
  Grade,
  HostHandle,
  ObserveEvent,
  Op,
  ProviderDriver,
  SubmitResult,
} from "../types.js";

interface ConversationRecord {
  id: string;
  agentId: string;
  issueId: string;
  cwd: string;
  model?: string;
  ops: string[];
  events: ObserveEvent[];
}

export class InMemoryDriver implements ProviderDriver {
  protected readonly conversations = new Map<string, ConversationRecord>();
  protected nextSession = 0;
  protected hostEpoch = 1;
  protected readonly ackGrade: Grade = "emitted_local";
  readonly submitCalls: { conversationId: string; opId: string }[] = [];

  capabilities(): Capabilities {
    return {
      provider: "opencode",
      inputKind: "http_api",
      ackGrade: this.ackGrade,
      receiptKinds: ["provider_event"],
      ownerPhone: { path: "in-memory://phone", proof: "UNSUPPORTED" },
      permission: { route: "none", proof: "UNSUPPORTED" },
      resume: { byId: true, proof: "SHIPPED-UNPROVEN" },
      interrupt: { scoped: true, proof: "OPEN" },
      needsPane: false,
      observeCoverage: "complete",
    };
  }

  async attestHost(agentId: string): Promise<HostHandle> {
    return {
      provider: "opencode",
      hostEpoch: this.hostEpoch,
      attested: true,
      detail: { agentId, transport: "in-memory" },
    };
  }

  protected createConversation(scope: ConvScope): ConversationRecord {
    this.nextSession += 1;
    const record: ConversationRecord = {
      id: `ses_${String(this.nextSession).padStart(4, "0")}`,
      agentId: scope.agentId,
      issueId: scope.issueId,
      cwd: scope.cwd,
      model: scope.model,
      ops: [],
      events: [],
    };
    this.conversations.set(record.id, record);
    return record;
  }

  protected findByScope(agentId: string, issueId: string): ConversationRecord | undefined {
    for (const conversation of this.conversations.values()) {
      if (conversation.agentId === agentId && conversation.issueId === issueId) return conversation;
    }
    return undefined;
  }

  protected requireConversation(conversationId: string): ConversationRecord {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`unknown conversation ${conversationId}`);
    return conversation;
  }

  async bindConversation(
    host: HostHandle,
    scope: ConvScope,
    mode: "new" | "resume",
    _fence: Fence,
  ): Promise<{ conversationId: string }> {
    if (!host.attested) throw new Error("refused: host is not attested");
    const existing = this.findByScope(scope.agentId, scope.issueId);
    if (mode === "new") {
      if (existing) throw new Error("refused: issue already owns a conversation");
      return { conversationId: this.createConversation(scope).id };
    }
    if (!existing) throw new Error("refused: no conversation to resume for this issue");
    if (existing.cwd !== scope.cwd || existing.model !== scope.model) {
      throw new Error("refused: foreign cwd/model for the recorded conversation");
    }
    return { conversationId: existing.id };
  }

  async submit(host: HostHandle, conversationId: string, op: Op, _fence: Fence): Promise<SubmitResult> {
    if (!host.attested) throw new Error("refused: host is not attested");
    const conversation = this.requireConversation(conversationId);
    if (conversation.ops.includes(op.opId)) {
      throw new Error(`replay refused: op ${op.opId} was already emitted to ${conversationId}`);
    }
    conversation.ops.push(op.opId);
    this.submitCalls.push({ conversationId, opId: op.opId });
    conversation.events.push({
      cursor: String(conversation.events.length + 1),
      kind: "hook_observed",
      opId: op.opId,
      raw: { source: "in-memory-driver", textLength: (op.text ?? "").length },
    });
    return {
      grade: this.ackGrade,
      evidence: `emitted op ${op.opId} on ${conversationId}`,
      at: new Date(0).toISOString(),
    };
  }

  async observe(
    conversationId: string,
    cursor?: string,
  ): Promise<{ events: ObserveEvent[]; next: string; coverage: "complete" | "incomplete" }> {
    const conversation = this.requireConversation(conversationId);
    const after = cursor
      ? conversation.events.filter((event) => Number(event.cursor) > Number(cursor))
      : [...conversation.events];
    return { events: after, next: String(conversation.events.length), coverage: "complete" };
  }

  async readOutcome(
    conversationId: string,
    opId: string,
  ): Promise<"receipted" | "hook_observed" | "working" | "unknown"> {
    const conversation = this.requireConversation(conversationId);
    if (!conversation.ops.includes(opId)) return "unknown";
    return conversation.events.some((event) => event.opId === opId && event.kind === "hook_observed")
      ? "hook_observed"
      : "working";
  }

  /** Test affordance: an owner/phone turn is plain activity, never an op. */
  addOwnerText(conversationId: string, text: string): ObserveEvent {
    const conversation = this.requireConversation(conversationId);
    const event: ObserveEvent = {
      cursor: String(conversation.events.length + 1),
      kind: "owner_text",
      raw: { textLength: text.length },
    };
    conversation.events.push(event);
    return event;
  }

  conversationIds(): string[] {
    return [...this.conversations.keys()];
  }
}
