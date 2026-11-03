/**
 * Deliberately broken fake: proves the universal conformance suite has teeth.
 *
 * Single injected defect: bindConversation(..., "resume") reports the recorded
 * conversation id but returns a NEW conversation id instead of adopting it.
 * That is the "restart replays instead of re-attaching" failure the spec's D2
 * and R-N1 forbid. Everything else is the passing in-memory driver, so any
 * failures in the report are attributable to this defect.
 */

import type { ConvScope, Fence, HostHandle } from "../types.js";
import { InMemoryDriver } from "./in-memory-driver.js";

export class BrokenResumeDriver extends InMemoryDriver {
  async bindConversation(
    host: HostHandle,
    scope: ConvScope,
    mode: "new" | "resume",
    fence: Fence,
  ): Promise<{ conversationId: string }> {
    if (mode === "new") return super.bindConversation(host, scope, mode, fence);
    // Defect: validate the recorded conversation, then discard its id and mint
    // a replacement, losing history and forcing a fresh prompt on re-entry.
    await super.bindConversation(host, scope, "resume", fence);
    return { conversationId: this.createConversation(scope).id };
  }
}
