import { isAbsolute } from "node:path";

export type ProviderProcessOwnership =
  | { kind: "owned_child" }
  | { kind: "shared_daemon"; socketPath: string; daemonGeneration: string; threadId: string; codexHome: string };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** This parses process ownership, never execution authority. Missing ownership
 * retains legacy behavior; malformed or conflicting declarations never do. */
export function readProviderProcessOwnership(input: unknown): ProviderProcessOwnership | undefined {
  const started = record(input), runtime = record(started.runtimeIdentity), descriptor = record(started.providerDescriptor);
  const declarations = [started, runtime, descriptor].filter(value => Object.hasOwn(value, "processOwnership"));
  if (!declarations.length) return undefined;
  const parsed = declarations.map(value => {
    const raw = record(value.processOwnership);
    if (raw.kind === "owned_child" && Object.keys(raw).length === 1) return { kind: "owned_child" } as const;
    if (raw.kind !== "shared_daemon" || Object.keys(raw).sort().join(",") !== "codexHome,daemonGeneration,kind,socketPath,threadId" ||
        !bounded(raw.socketPath, 4096) || !isAbsolute(raw.socketPath) || !bounded(raw.codexHome, 4096) || !isAbsolute(raw.codexHome) ||
        !bounded(raw.daemonGeneration, 1024) || !bounded(raw.threadId, 240)) throw new Error("invalid provider process ownership");
    return { kind: "shared_daemon", socketPath: raw.socketPath, daemonGeneration: raw.daemonGeneration, threadId: raw.threadId, codexHome: raw.codexHome } as const;
  });
  const ownership = parsed[0]!;
  if (parsed.some(value => JSON.stringify(value) !== JSON.stringify(ownership))) throw new Error("conflicting provider process ownership");
  if (ownership.kind === "shared_daemon") {
    // A daemon PID is never this Runner's child, even if supplied as null or
    // hidden in a legacy identity alias. Refuse instead of promoting it later.
    if ([started, runtime, descriptor].some(value => ["processId", "process_id", "pid", "agentProcessId"].some(key => Object.hasOwn(value, key)))) throw new Error("shared daemon identity must omit process IDs");
    // Check every supplied alias, not just the first one: a correct root ID
    // must not conceal a foreign identity in the runtime or descriptor.
    const threads = [started, runtime, descriptor].flatMap(value =>
      ["threadId", "driverSessionId", "providerSessionId"].filter(key => Object.hasOwn(value, key)).map(key => value[key]));
    if (threads.some(thread => thread !== ownership.threadId)) throw new Error("shared daemon thread identity mismatch");
  }
  return ownership;
}
