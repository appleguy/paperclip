import type { NativeSessionBackend, NativeSession, OpenNativeSessionInput } from "../../contracts/native-session-backend.js";
import type { NativeRunIdentity, NativeSessionCapabilities } from "../../contracts/types.js";
import { AntigravityHeadlessController } from "./headless-controller.js";
const capabilities: NativeSessionCapabilities = { resume: false, typedEvents: false, steering: false, interruption: false, structuredResult: false, providerTermination: "unavailable", unsupported: ["automatic recovery", "turn dispatch", "approval responses", "interrupt", "interactive remote control"] };
/** Opt-in exact-conversation bootstrap; no PRP commands or prompts are sent. */
export class AntigravityHeadlessNativeBackend implements NativeSessionBackend {
  private readonly binding: { executable: string; verifiedVersion: string; cwd: string; conversationId: string; identity: NativeRunIdentity; env: NodeJS.ProcessEnv; timeoutMs?: number };
  constructor(binding: { executable: string; verifiedVersion: string; cwd: string; conversationId: string; identity: NativeRunIdentity; env: NodeJS.ProcessEnv; timeoutMs?: number }) { this.binding = { ...binding, identity: { ...binding.identity }, env: { ...binding.env } }; }
  async descriptor() { return { kind: "runner" as const, name: "antigravity-headless-observer", version: "1.4.12", capabilities }; }
  async openSession(input: OpenNativeSessionInput): Promise<NativeSession> {
    const b = this.binding;
    if (input.workingDirectory !== b.cwd || Object.keys(b.identity).some(key => input.identity[key as keyof NativeRunIdentity] !== b.identity[key as keyof NativeRunIdentity])) throw new Error("Native identity mismatch");
    if (input.signal?.aborted) throw new Error("Native bootstrap aborted");
    let ready!: () => void;
    const initialized = new Promise<void>(resolve => { ready = resolve; });
    const controller = AntigravityHeadlessController.launch({ executable: b.executable, verifiedVersion: b.verifiedVersion, cwd: b.cwd, conversationId: b.conversationId, env: b.env,
      authorize: () => false, onEvent: event => { if (event.kind === "init") ready(); }, onUncertain: () => {} });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      await Promise.race([initialized, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native init timeout")), b.timeoutMs ?? 5000);
        aborted = () => reject(new Error("Native bootstrap aborted"));
        input.signal?.addEventListener("abort", aborted, { once: true });
        if (input.signal?.aborted) aborted();
      })]);
    } catch (error) { await controller.closeOwned(); throw error; }
    finally { if (timer) clearTimeout(timer); if (aborted) input.signal?.removeEventListener("abort", aborted); }
    let closed = false;
    const session: NativeSession = {
      identity: () => ({ ...b.identity }), capabilities: async () => ({ ...capabilities }),
      async *events() {},
      async startTurn() { throw new Error("Antigravity headless turn dispatch has no durable owner"); },
      async result() { return null; },
      async snapshot() { return { backendKind: "runner", driverKind: "antigravity_headless_observer", sessionId: b.identity.sessionId, identity: { ...b.identity }, providerSessionId: b.conversationId, workingDirectory: b.cwd }; },
      async close() { if (!closed) { closed = true; await controller.closeOwned(); } },
    };
    return session;
  }
}
