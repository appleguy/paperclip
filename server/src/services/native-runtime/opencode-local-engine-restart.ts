import type { Db } from "@paperclipai/db";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { freezeOpenCodeManagedHost, resumeOpenCodeManagedHost, verifyOpenCodeManagedProviderTarget } from "./opencode-host-registry.js";

/** Produced by a trusted engine owner, not by an OpenAI model alias. Hashes
 * cover the actual model, tokenizer, template, executable and effective config. */
export type LocalEngineIdentity = Readonly<{
  route: string; model: string; generation: string;
  modelSha256: string; tokenizerSha256: string; templateSha256: string;
  executableSha256: string; configSha256: string;
}>;

/** A host admission implementation must fence all other requests and leases
 * throughout the callback, while allowing this session to reach its boundary.
 * It must bind the route and model to the exact engine and restart only that
 * engine. No generic HTTP endpoint or catalog response provides this authority. */
export interface LocalEngineRestartAuthority {
  withExclusiveRestart<T>(binding: OpenCodeSharedBinding, signal: AbortSignal, work: (engine: {
    identity(signal: AbortSignal): Promise<LocalEngineIdentity>;
    restart(signal: AbortSignal): Promise<void>;
  }) => Promise<T>): Promise<T>;
}

function valid(identity: LocalEngineIdentity, binding: OpenCodeSharedBinding): void {
  if (!identity || !identity.route || !identity.generation || !binding.model.startsWith("paperclip/") || identity.model !== binding.model.slice("paperclip/".length) ||
      [identity.modelSha256, identity.tokenizerSha256, identity.templateSha256, identity.executableSha256, identity.configSha256].some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("opencode_local_engine_identity_unproven");
  }
}

function sameEngine(a: LocalEngineIdentity, b: LocalEngineIdentity): boolean {
  return a.route === b.route && a.model === b.model && a.modelSha256 === b.modelSha256 &&
    a.tokenizerSha256 === b.tokenizerSha256 && a.templateSha256 === b.templateSha256 &&
    a.executableSha256 === b.executableSha256 && a.configSha256 === b.configSha256;
}

/** Inference restart only. The exclusive host authority and controller lease
 * must remain live until resume. Any error invalidates the held request. */
export async function restartOpenCodeLocalEngine(input: {
  db: Db; binding: OpenCodeSharedBinding; authority: LocalEngineRestartAuthority;
  expected: LocalEngineIdentity; timeoutMs: number; signal: AbortSignal;
}): Promise<{ requestSha256: string; previousGeneration: string; generation: string }> {
  const binding = Object.freeze({ ...input.binding, controllerProcessStartedAt: new Date(input.binding.controllerProcessStartedAt) });
  valid(input.expected, binding);
  const expected = Object.freeze({ ...input.expected });
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) throw new Error("opencode_local_restart_invalid_deadline");
  const abort = new AbortController();
  const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(input.timeoutMs)]);
  try {
    return await input.authority.withExclusiveRestart(binding, signal, async engine => {
      try {
      signal.throwIfAborted();
      await verifyOpenCodeManagedProviderTarget(input.db, binding, expected.route);
      signal.throwIfAborted();
      const before = Object.freeze({ ...await engine.identity(signal) });
      valid(before, binding);
      if (!sameEngine(before, expected) || before.generation !== expected.generation) throw new Error("opencode_local_engine_identity_changed");
      const checkpoint = await freezeOpenCodeManagedHost(input.db, binding, { timeoutMs: input.timeoutMs, signal });
      signal.throwIfAborted();
      const atBoundary = Object.freeze({ ...await engine.identity(signal) });
      valid(atBoundary, binding);
      if (!sameEngine(before, atBoundary) || before.generation !== atBoundary.generation) throw new Error("opencode_local_engine_identity_changed");
      await engine.restart(signal);
      signal.throwIfAborted();
      const after = Object.freeze({ ...await engine.identity(signal) });
      valid(after, binding);
      if (!sameEngine(before, after) || before.generation === after.generation) throw new Error("opencode_local_engine_restart_unverified");
      signal.throwIfAborted();
      await resumeOpenCodeManagedHost(input.db, binding, checkpoint, signal);
      return { requestSha256: checkpoint.requestSha256, previousGeneration: before.generation, generation: after.generation };
      } catch (error) { abort.abort(error); throw error; }
    });
  } catch (error) { abort.abort(error); throw error; }
}
