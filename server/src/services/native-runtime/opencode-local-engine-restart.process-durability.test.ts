import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import {
  DurablePrpControlPlane,
  decodeDurablePrpCheckpoint,
  OpenCodeProviderBoundary as BoundaryConstructor,
  type DurablePrpCheckpoint,
} from "../../vendor/paperclip-runner/index.js";

// The vendor shim narrows the boundary to freeze/resume/close; the held-request
// entry point is on the package class it re-exports.
type ProviderBoundary = {
  freeze(input: { timeoutMs: number; signal: AbortSignal }): Promise<{ id: string; requestSha256: string }>;
  resume(checkpoint: { id: string; requestSha256: string }): void;
  enter(body: Buffer, payload: Record<string, unknown>, signal: AbortSignal): Promise<() => void>;
  close(): void;
};
const OpenCodeProviderBoundary = BoundaryConstructor as unknown as new () => ProviderBoundary;

const identity = {
  runnerInstanceId: "runner-process-durability",
  environmentLeaseId: "lease-process-durability",
  runId: "run-process-durability",
  normalizedSessionId: "session-process-durability",
  turnId: "turn-process-durability",
  itemId: "item-process-durability",
};
const expectedRunnerVersion = "fixture-2.2.5";
const expectedRunnerDigest = `sha256:${"a".repeat(64)}`;

// A complete tool batch: the proxy holds exactly this next-turn request at the
// provider boundary while the engine is restarted.
const heldBody = JSON.stringify({
  model: "fixture",
  messages: [
    { role: "user", content: "continue the turn" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "tool result" },
  ],
  temperature: 0,
  stream: false,
});

function options(root: string) {
  return {
    stateDirectory: resolve(root, "control-plane"),
    identity,
    expectedRunnerVersion,
    expectedRunnerDigest,
  };
}

it("resumes the held tool-boundary continuation exactly once while the proxy process is alive", async () => {
  const boundary = new OpenCodeProviderBoundary();
  const engineRequests: string[] = [];
  try {
    const frozen = boundary.freeze({ timeoutMs: 5_000, signal: new AbortController().signal });
    const held = boundary.enter(
      Buffer.from(heldBody),
      JSON.parse(heldBody),
      new AbortController().signal,
    );
    const checkpoint = await frozen;
    expect(checkpoint.requestSha256).toBe(createHash("sha256").update(heldBody).digest("hex"));
    expect(engineRequests).toEqual([]);

    boundary.resume(checkpoint);
    await held;
    engineRequests.push(heldBody);
    expect(engineRequests).toEqual([heldBody]);
    // The held request is single-use; a second resume cannot replay it.
    expect(() => boundary.resume(checkpoint)).toThrow("provider_boundary_checkpoint_mismatch");
  } finally {
    boundary.close();
  }
});

it("restores the same owner and history after process death without replaying the held continuation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "opencode-process-durability-"));
  const first = new DurablePrpControlPlane(options(root));
  const firstBoundary = new OpenCodeProviderBoundary();
  const engineRequests: string[] = [];
  let checkpoint!: DurablePrpCheckpoint;
  let restored: DurablePrpControlPlane | undefined;
  let held: Promise<() => void> | undefined;
  try {
    // Mid-turn history: identity anchors survive, streamed deltas do not.
    first.store.state.committedEvents.push(
      {
        sourceSeq: 1,
        sourceEventId: "session-started",
        eventType: "session.started",
        priority: 0,
        envelope: { ...identity },
        deliveryCount: 1,
        logicalEffectCount: 1,
      },
      {
        sourceSeq: 2,
        sourceEventId: "turn-started",
        eventType: "turn.started",
        priority: 0,
        envelope: { ...identity },
        deliveryCount: 1,
        logicalEffectCount: 1,
      },
      {
        sourceSeq: 3,
        sourceEventId: "stream-1",
        eventType: "item.delta",
        priority: 2,
        envelope: { ...identity },
        deliveryCount: 1,
        logicalEffectCount: 1,
      },
    );
    first.store.state.ackedSourceSeq = 3;

    // The turn was already admitted exactly once before the process died.
    const continuation = first.queueCommand(
      "turn.start",
      { prompt: "continue" },
      "turn-continuation",
    );

    // The proxy holds the next tool-boundary request in memory only.
    const frozen = firstBoundary.freeze({ timeoutMs: 5_000, signal: new AbortController().signal });
    held = firstBoundary.enter(
      Buffer.from(heldBody),
      JSON.parse(heldBody),
      new AbortController().signal,
    );
    const boundaryCheckpoint = await frozen;

    first.setCheckpointPersistence(async saved => {
      checkpoint = saved;
    });
    await first.flushCheckpoint();

    expect(checkpoint.workCommandIds).toEqual(["turn-continuation"]);
    expect(checkpoint.records.get("command:1")).toContain("turn-continuation");
    // Streamed output is excluded from the durable control checkpoint.
    expect([...checkpoint.records.keys()].filter(key => key.startsWith("event:"))).toEqual([
      "event:1",
      "event:2",
    ]);

    // Process death: the local controller directory and the memory-only
    // boundary are both gone. Only the external checkpoint survives.
    await first.stop();
    firstBoundary.close();
    await expect(held).rejects.toThrow("provider_boundary_closed");
    rmSync(options(root).stateDirectory, { recursive: true, force: true });
    expect(existsSync(options(root).stateDirectory)).toBe(false);

    // Restore the durable checkpoint into a fresh process directory.
    decodeDurablePrpCheckpoint(checkpoint.records).restoreSessionDirectory(root);
    restored = new DurablePrpControlPlane(options(root));

    // Same owner and same committed history.
    expect(restored.store.state.identity).toEqual(identity);
    expect(restored.store.state.committedEvents.map(event => event.eventType)).toEqual([
      "session.started",
      "turn.started",
    ]);
    expect(restored.store.state.ackedSourceSeq).toBe(3);
    expect(restored.recoveredSourceSeq).toBe(3);
    // Exactly one continuation, with its original command identity.
    expect(restored.store.state.commands).toEqual([continuation]);
    expect(restored.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);
    expect(restored.getCommand("turn-continuation")).toEqual(continuation);

    // A fresh boundary cannot resume the dead process's held request, so the
    // continuation is never sent to the engine a second time.
    const freshBoundary = new OpenCodeProviderBoundary();
    try {
      await expect(
        (async () => {
          freshBoundary.resume(boundaryCheckpoint);
          engineRequests.push(heldBody);
        })(),
      ).rejects.toThrow("provider_boundary_checkpoint_mismatch");
      expect(engineRequests).toEqual([]);
    } finally {
      freshBoundary.close();
    }

    // Replaying the same command ID is idempotent: no duplicate is journaled.
    expect(
      restored.queueCommand("turn.start", { prompt: "continue" }, "turn-continuation"),
    ).toEqual(continuation);
    expect(restored.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);

    // The next durable checkpoint still carries exactly one continuation.
    let secondCheckpoint!: DurablePrpCheckpoint;
    restored.setCheckpointPersistence(async saved => {
      secondCheckpoint = saved;
    });
    await restored.flushCheckpoint();
    expect(secondCheckpoint.workCommandIds).toEqual(["turn-continuation"]);
    expect([...secondCheckpoint.records.keys()].filter(key => key.startsWith("command:"))).toHaveLength(1);
  } finally {
    firstBoundary.close();
    if (held) await held.catch(() => undefined);
    await restored?.stop();
    await first.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
