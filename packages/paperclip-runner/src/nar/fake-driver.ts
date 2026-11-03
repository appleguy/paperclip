// Fake provider drivers for the conformance suite (spec section 8: fake providers
// first, no model calls, no paid inference). One class, parameterized by provider,
// with fault injection at each transport crash window.
import { randomBytes, randomUUID } from "node:crypto";
import { CAPABILITIES } from "./capabilities.js";
import type {
  Capabilities,
  ConvScope,
  Fence,
  Grade,
  HostHandle,
  ObserveEvent,
  Op,
  OutcomeRead,
  Provider,
  ProviderDriver,
  SubmitResult,
} from "./driver.js";

export type SubmitFault = "throw_before_write" | "throw_after_write" | "unknown_grade";

interface FakeConversation {
  agentId: string;
  issueId: string;
  cwd: string;
  model?: string;
}

export class FakeDriver implements ProviderDriver {
  hosts = new Map<string, number>(); // agentId -> epoch
  conversations = new Map<string, FakeConversation>();
  delivered = new Map<string, OutcomeRead>(); // opId -> provider-side view
  lost = new Set<string>();
  submits: { opId: string; conversationId: string }[] = [];
  createCalls = 0;
  submitFault?: SubmitFault;
  createFault = false;
  unrelated = new Map<string, string>(); // sessions this driver must never touch

  constructor(
    readonly provider: Provider,
    private readonly secret: string,
    private readonly ackOverride?: Grade,
  ) {}

  capabilities(): Capabilities {
    const c = CAPABILITIES[this.provider];
    return this.ackOverride ? { ...c, ackGrade: this.ackOverride } : c;
  }

  newId(): string {
    const hex = randomBytes(8).toString("hex");
    switch (this.provider) {
      case "claude":
        return randomUUID();
      case "opencode":
        return `ses_${hex}`;
      case "agy":
        return `agy-${hex}`;
      case "codex":
        return `thr_${hex}`;
    }
  }

  async attestHost(agentId: string, opts?: { create?: boolean }): Promise<HostHandle> {
    let epoch = this.hosts.get(agentId);
    if (epoch === undefined) {
      if (!opts?.create) throw new Error("no host for agent; admission (create) required");
      epoch = 1;
      this.hosts.set(agentId, epoch);
    }
    return { provider: this.provider, hostEpoch: epoch, attested: true, detail: { endpointToken: this.secret } };
  }

  async bindConversation(
    _h: HostHandle,
    s: ConvScope,
    mode: "new" | "resume",
    _f: Fence,
    existingId?: string,
  ): Promise<{ conversationId: string; cwd: string; model?: string }> {
    if (mode === "resume") {
      const c = existingId ? this.conversations.get(existingId) : undefined;
      if (!c) throw new Error("resume: no such conversation");
      return { conversationId: existingId!, cwd: c.cwd, model: c.model };
    }
    this.createCalls++;
    const id = this.newId();
    this.conversations.set(id, { agentId: s.agentId, issueId: s.issueId, cwd: s.cwd, model: s.model });
    if (this.createFault) throw new Error("creation response lost");
    return { conversationId: id, cwd: s.cwd, model: s.model };
  }

  async submit(_h: HostHandle, conversationId: string, op: Op, _f: Fence): Promise<SubmitResult> {
    if (this.submitFault === "throw_before_write") throw new Error("transport error before write");
    this.submits.push({ opId: op.opId, conversationId });
    this.delivered.set(op.opId, "working");
    if (this.submitFault === "throw_after_write") throw new Error("transport error after write");
    if (this.submitFault === "unknown_grade") {
      return { grade: "outcome_unknown", evidence: "no response", at: new Date().toISOString() };
    }
    return { grade: this.capabilities().ackGrade, evidence: "fake write", at: new Date().toISOString() };
  }

  async observe(_conversationId: string, cursor?: string) {
    const all = [...this.delivered.entries()].filter(([id]) => !this.lost.has(id));
    const start = cursor ? Number(cursor) : 0;
    const events: ObserveEvent[] = all
      .slice(start)
      .map(([opId, kind], i) => ({ cursor: String(start + i + 1), kind, opId, raw: null }));
    return { events, next: String(all.length), coverage: this.capabilities().observeCoverage };
  }

  async readOutcome(_conversationId: string, opId: string): Promise<OutcomeRead> {
    if (this.lost.has(opId)) return "unknown";
    return this.delivered.get(opId) ?? "unknown";
  }

  // ---- test controls ----
  lose(opId: string) {
    this.lost.add(opId);
  }
  hook(opId: string) {
    this.delivered.set(opId, "hook_observed");
  }
  restartHost(agentId: string) {
    this.hosts.set(agentId, (this.hosts.get(agentId) ?? 0) + 1);
  }
  tamper(conversationId: string, patch: Partial<FakeConversation>) {
    const c = this.conversations.get(conversationId);
    if (c) Object.assign(c, patch);
  }
}
