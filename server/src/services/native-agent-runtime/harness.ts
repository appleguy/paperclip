/**
 * Shared scene helpers for the universal conformance suite.
 *
 * Deliberately separate from conformance.ts so the suite and the test cases can
 * import helpers without a module cycle.
 */

import { ReferenceCore, type Caller, type CoreResult, type Lease, type OpMeta } from "./reference-core.js";
import type { ConvScope, Fence, HostHandle, Op, ProviderDriver, Receipt } from "./types.js";

const DIGESTS = ["a", "b", "c", "d", "e", "f", "1", "2", "3", "4"] as const;

export function digest(index: number): string {
  const char = DIGESTS[index % DIGESTS.length];
  return char.repeat(64);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectOk<T>(result: CoreResult<T>, where: string): T {
  if (!result.ok) throw new Error(`${where}: refused with ${result.code} (${result.detail})`);
  return result.value;
}

export interface Clock {
  value: number;
}

export interface SceneOptions {
  issueId?: string;
  runId?: string;
  agentId?: string;
  leaseGeneration?: number;
  hostEpoch?: number;
  controllerId?: string;
  clientIntent?: string;
  cwd?: string;
  model?: string;
  clock?: Clock;
}

export interface Scene {
  driver: ProviderDriver;
  core: ReferenceCore;
  clock: Clock;
  host: HostHandle;
  scope: ConvScope;
  fence: Fence;
  caller: Caller;
  conversationId: string;
  issueId: string;
  runId: string;
  meta(overrides?: Partial<OpMeta>): OpMeta;
  op(index?: number, overrides?: Partial<Op>): Op;
  receipt(kind: Receipt["kind"], op: Op, overrides?: Partial<Receipt>): Receipt;
}

const DEFAULT_CLOCK = 1_700_000_000_000;

export function makeClock(value: number = DEFAULT_CLOCK): Clock {
  return { value };
}

export async function openScene(driver: ProviderDriver, options: SceneOptions = {}): Promise<Scene> {
  const clock = options.clock ?? makeClock();
  const core = new ReferenceCore(driver, () => clock.value);
  const issueId = options.issueId ?? "issue-1";
  const runId = options.runId ?? "run-1";
  const agentId = options.agentId ?? "agent-1";
  const fence: Fence = {
    runId,
    leaseGeneration: options.leaseGeneration ?? 2,
    hostEpoch: options.hostEpoch ?? 1,
  };
  const caller: Caller = { controllerId: options.controllerId ?? "controller-a" };
  const scope: ConvScope = {
    agentId,
    issueId,
    cwd: options.cwd ?? "/tmp/nar-conformance",
    model: options.model ?? "conf-model",
  };
  const lease: Lease = {
    runId,
    issueId,
    leaseGeneration: fence.leaseGeneration,
    controllerId: caller.controllerId,
    hostEpoch: fence.hostEpoch,
    expiresAt: clock.value + 60_000,
  };
  core.registerLease(lease);
  const host = expectOk(await core.attestHost(agentId), "attestHost");
  const bound = expectOk(
    await core.bindConversation(host, scope, "new", fence, caller),
    "bindConversation(new)",
  );
  const clientIntent = options.clientIntent ?? "intent-1";
  const scene: Scene = {
    driver,
    core,
    clock,
    host,
    scope,
    fence,
    caller,
    conversationId: bound.conversationId,
    issueId,
    runId,
    meta: (overrides) => ({
      issueId: overrides?.issueId ?? issueId,
      conversationId: overrides?.conversationId ?? bound.conversationId,
      clientIntent: overrides?.clientIntent ?? clientIntent,
    }),
    op: (index = 0, overrides) => ({
      opId: overrides?.opId ?? `${runId}-op-${index}`,
      kind: overrides?.kind ?? "prompt",
      payloadSha256: overrides?.payloadSha256 ?? digest(index),
      text: overrides?.text ?? `do work ${index}`,
    }),
    receipt: (kind, op, overrides) => ({
      receiptId: overrides?.receiptId ?? `${runId}-receipt-${op.opId}`,
      kind,
      runId: overrides?.runId ?? runId,
      issueId: overrides?.issueId ?? issueId,
      conversationId: overrides?.conversationId ?? bound.conversationId,
      opId: overrides?.opId ?? op.opId,
      hostEpoch: overrides?.hostEpoch ?? fence.hostEpoch,
      leaseGeneration: overrides?.leaseGeneration ?? fence.leaseGeneration,
      controllerId: overrides?.controllerId ?? caller.controllerId,
      payloadSha256: overrides?.payloadSha256 ?? op.payloadSha256,
      at: overrides?.at ?? new Date(clock.value).toISOString(),
      result: kind === "finish" ? (overrides?.result ?? { status: "done" }) : overrides?.result,
      reason: kind === "block" ? (overrides?.reason ?? "blocked in fake") : overrides?.reason,
    }),
  };
  return scene;
}
