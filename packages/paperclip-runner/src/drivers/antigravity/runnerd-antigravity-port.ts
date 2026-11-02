import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { atomicPrivateWrite, type DurablePrpControlPlane } from "../../control-plane/durable-prp-control-plane.js";
import { AntigravityHeadlessController } from "./headless-controller.js";
import type { NativeEvent } from "./native-control.js";

/** Consumer for an already committed Runner dispatch event. It cannot attach
 * itself to PRP; the Rust provider codec must own and emit the event. */
export class RunnerdAntigravityPort {
  private active?: { sourceEventId: string; id: string };
  constructor(private readonly input: { controller: AntigravityHeadlessController; journalDirectory: string;
    conversationId: string; processGeneration: string; bindingId: string; bindingGeneration: number; runId: string; environmentLeaseId: string; normalizedSessionId: string; turnId: string;
    admit: (sourceEventId: string) => boolean;
    queueResult: (commandId: string, payload: Record<string, unknown>) => void }) {
    if (!isAbsolute(input.journalDirectory) || !input.conversationId || !input.processGeneration || !input.bindingId || !input.runId || !input.environmentLeaseId || !input.normalizedSessionId || !input.turnId || !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 1) throw new Error("Invalid Antigravity port binding");
  }
  dispatch(event: { schema: string; schemaVersion: number; eventType: string; sourceEventId: string; payload: Record<string, unknown> }): { disposition: "written_consumption_unknown" } {
    const { journalDirectory: dir, conversationId, processGeneration, bindingId, bindingGeneration } = this.input;
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Antigravity journal must be private and owned");
    const binding = event.payload.binding;
    if (event.schema !== "paperclip.prp.event.v2" || event.schemaVersion !== 2 || event.eventType !== "native_controller.dispatch_requested" || !event.sourceEventId || event.sourceEventId.length > 256 || !binding || typeof binding !== "object" || Array.isArray(binding) ||
      (binding as Record<string, unknown>).bindingId !== bindingId || (binding as Record<string, unknown>).bindingGeneration !== bindingGeneration ||
      (binding as Record<string, unknown>).runId !== this.input.runId || (binding as Record<string, unknown>).environmentLeaseId !== this.input.environmentLeaseId || (binding as Record<string, unknown>).normalizedSessionId !== this.input.normalizedSessionId || (binding as Record<string, unknown>).turnId !== this.input.turnId ||
      typeof event.payload.text !== "string" || event.payload.inputDigest !== `sha256:${createHash("sha256").update(event.payload.text).digest("hex")}` || !this.input.admit(event.sourceEventId)) throw new Error("Antigravity dispatch denied");
    const text = event.payload.text;
    const id = createHash("sha256").update(event.sourceEventId).digest("hex");
    const path = join(dir, `${id}.reservation`);
    const record = JSON.stringify({ schema: "paperclip.antigravity.dispatch.v1", sourceEventId: event.sourceEventId, conversationId, processGeneration, bindingId, bindingGeneration, runId: this.input.runId, environmentLeaseId: this.input.environmentLeaseId, normalizedSessionId: this.input.normalizedSessionId, turnId: this.input.turnId, inputSha256: createHash("sha256").update(text).digest("hex") });
    let fd: number;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Existing, partial and conflicting reservations are all never replayed.
      throw new Error("Antigravity dispatch outcome uncertain; reconcile without replay");
    }
    try { if (!fstatSync(fd).isFile()) throw new Error("Invalid reservation"); writeFileSync(fd, record); fsyncSync(fd); } finally { closeSync(fd); }
    // The existing durable private atomic writer fsyncs the parent directory,
    // establishing the reservation before any provider write.
    atomicPrivateWrite(join(dir, `${id}.ready`), record);
    this.active = { sourceEventId: event.sourceEventId, id };
    const receipt = this.input.controller.submit(event.sourceEventId, text);
    atomicPrivateWrite(join(dir, `${id}.written`), JSON.stringify({ disposition: receipt.disposition }));
    return { disposition: receipt.disposition };
  }

  /** Consume only an exact native result from this controller; the callback
   * must enqueue `native_controller.observation` through the durable PRP core.
   * A native result is observation, never Paperclip task completion. */
  observe(event: NativeEvent): void {
    if (event.conversationId !== this.input.conversationId) throw new Error("Antigravity native conversation mismatch");
    if (event.kind !== "result") return;
    if (!event.status || event.status.length > 160 || (event.numTurns !== undefined && (!Number.isSafeInteger(event.numTurns) || event.numTurns < 0))) throw new Error("Invalid Antigravity native result");
    const active = this.active;
    if (!active) throw new Error("Antigravity result has no admitted dispatch");
    const result = { status: event.status, ...(event.response === undefined ? {} : { response: event.response }), ...(event.numTurns === undefined ? {} : { numTurns: event.numTurns }) };
    const record = JSON.stringify(result);
    if (Buffer.byteLength(record) > 1024 * 1024) throw new Error("Antigravity native result exceeds bound");
    atomicPrivateWrite(join(this.input.journalDirectory, `${active.id}.result`), record);
    this.queueNativeResult(active.sourceEventId, active.id, result);
    this.active = undefined;
  }

  /** Re-enqueue a persisted native result under the same PRP command ID.
   * Missing or partial result evidence remains unknown and never resends input. */
  recoverResult(sourceEventId: string): void {
    if (!sourceEventId || !this.input.admit(sourceEventId)) throw new Error("Antigravity recovery denied");
    const dir = lstatSync(this.input.journalDirectory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))) throw new Error("Antigravity journal must be private and owned");
    const id = createHash("sha256").update(sourceEventId).digest("hex");
    const read = (suffix: string): string => {
      const fd = openSync(join(this.input.journalDirectory, `${id}.${suffix}`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Invalid Antigravity evidence");
        return readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
    };
    const reservation = JSON.parse(read("reservation")) as Record<string, unknown>;
    if (read("ready") !== JSON.stringify(reservation) || reservation.schema !== "paperclip.antigravity.dispatch.v1" || reservation.sourceEventId !== sourceEventId || reservation.conversationId !== this.input.conversationId || reservation.processGeneration !== this.input.processGeneration || reservation.bindingId !== this.input.bindingId || reservation.bindingGeneration !== this.input.bindingGeneration || reservation.runId !== this.input.runId || reservation.environmentLeaseId !== this.input.environmentLeaseId || reservation.normalizedSessionId !== this.input.normalizedSessionId || reservation.turnId !== this.input.turnId) throw new Error("Antigravity recovery binding mismatch");
    const result = JSON.parse(read("result")) as Record<string, unknown>;
    if (typeof result.status !== "string" || !result.status || (result.response !== undefined && typeof result.response !== "string")) throw new Error("Invalid Antigravity result evidence");
    this.queueNativeResult(sourceEventId, id, result);
  }
  private queueNativeResult(sourceEventId: string, id: string, result: Record<string, unknown>): void {
    this.input.queueResult(`agy_result_${id}`, { action: "antigravity.native_result", bindingId: this.input.bindingId,
      bindingGeneration: this.input.bindingGeneration, runId: this.input.runId, environmentLeaseId: this.input.environmentLeaseId, normalizedSessionId: this.input.normalizedSessionId,
      turnId: this.input.turnId, conversationId: this.input.conversationId, processGeneration: this.input.processGeneration,
      dispatchEventId: sourceEventId, result });
  }
  /** Commits an exit observation only after this controller's exact child closes. */
  async closeOwned(): Promise<void> {
    await this.input.controller.closeOwned();
    const id = createHash("sha256").update(`${this.input.bindingId}\0${this.input.processGeneration}`).digest("hex");
    this.input.queueResult(`agy_exit_${id}`, { action: "antigravity.provider_exit", bindingId: this.input.bindingId,
      bindingGeneration: this.input.bindingGeneration, runId: this.input.runId, environmentLeaseId: this.input.environmentLeaseId,
      normalizedSessionId: this.input.normalizedSessionId, turnId: this.input.turnId, conversationId: this.input.conversationId,
      processGeneration: this.input.processGeneration, exitObserved: true });
  }
}

/** Explicit opt-in wiring: the only result writer is the same authenticated
 * durable PRP core that delivered the dispatch event. The caller must prove
 * executable/version and child generation and call dispatch only after commit. */
export function launchRunnerdAntigravity(input: { core: DurablePrpControlPlane; executable: string; verifiedVersion: string;
  cwd: string; env: NodeJS.ProcessEnv; journalDirectory: string; conversationId: string;
  bindingId: string; bindingGeneration: number; runId: string; environmentLeaseId: string; normalizedSessionId: string; turnId: string;
  admit: (sourceEventId: string) => boolean; onUncertain: (sourceEventId: string) => void;
  onEvent?: (event: NativeEvent) => void }): { controller: AntigravityHeadlessController; port: RunnerdAntigravityPort } {
  if (!isAbsolute(input.journalDirectory) || !input.conversationId || !input.bindingId || !input.runId || !input.environmentLeaseId || !input.normalizedSessionId || !input.turnId || !Number.isSafeInteger(input.bindingGeneration) || input.bindingGeneration < 1) throw new Error("Invalid Antigravity port binding");
  const directory = lstatSync(input.journalDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))) throw new Error("Antigravity journal must be private and owned");
  let port: RunnerdAntigravityPort | undefined;
  const controller = AntigravityHeadlessController.launch({ executable: input.executable, verifiedVersion: input.verifiedVersion,
    cwd: input.cwd, conversationId: input.conversationId, env: input.env, authorize: input.admit,
    onUncertain: input.onUncertain, onEvent: (event: NativeEvent) => { port?.observe(event); input.onEvent?.(event); } });
  port = new RunnerdAntigravityPort({ controller, journalDirectory: input.journalDirectory, conversationId: input.conversationId,
    processGeneration: controller.generation, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration,
    runId: input.runId, environmentLeaseId: input.environmentLeaseId, normalizedSessionId: input.normalizedSessionId, turnId: input.turnId, admit: input.admit,
    queueResult: (id, payload) => { input.core.queueCommand("native_controller.observation", payload, id, true); } });
  return { controller, port };
}
