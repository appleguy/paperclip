import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AntigravityInteractiveControl } from "./interactive-control.js";

/** Consumes a committed Runner dispatch event for one checkpointed seat. */
export class RunnerdAntigravityInteractivePort {
  constructor(private readonly input: {
    control: Pick<AntigravityInteractiveControl, "submit">;
    bindingId: string; bindingGeneration: number; runId: string; environmentLeaseId: string;
    normalizedSessionId: string; turnId: string; stateDir: string; admit: (sourceEventId: string) => boolean;
  }) {
    if (![input.bindingId, input.runId, input.environmentLeaseId, input.normalizedSessionId, input.turnId].every(Boolean) ||
      !path.isAbsolute(input.stateDir) || !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 1) throw new Error("Invalid Antigravity interactive binding");
  }

  async dispatch(event: { schema: string; schemaVersion: number; eventType: string; sourceEventId: string; payload: Record<string, unknown> }): Promise<{ disposition: "written_consumption_unknown" }> {
    const b = event.payload.binding;
    if (event.schema !== "paperclip.prp.event.v2" || event.schemaVersion !== 2 || event.eventType !== "native_controller.dispatch_requested" ||
      !event.sourceEventId || event.sourceEventId.length > 256 || !b || typeof b !== "object" || Array.isArray(b) ||
      Object.entries({ bindingId: this.input.bindingId, bindingGeneration: this.input.bindingGeneration, runId: this.input.runId,
        environmentLeaseId: this.input.environmentLeaseId, normalizedSessionId: this.input.normalizedSessionId, turnId: this.input.turnId })
        .some(([key, value]) => (b as Record<string, unknown>)[key] !== value) ||
      typeof event.payload.text !== "string" || event.payload.inputDigest !== `sha256:${createHash("sha256").update(event.payload.text).digest("hex")}` ||
      !this.input.admit(event.sourceEventId)) throw new Error("Antigravity interactive dispatch denied");
    const checkpoint = JSON.parse(await readFile(path.join(this.input.stateDir, "active.json"), "utf8")) as { runId?: unknown };
    if (checkpoint.runId !== this.input.runId || !this.input.admit(event.sourceEventId)) throw new Error("Antigravity interactive checkpoint ownership changed");
    return this.input.control.submit(event.sourceEventId, event.payload.text, this.input.runId);
  }
}
