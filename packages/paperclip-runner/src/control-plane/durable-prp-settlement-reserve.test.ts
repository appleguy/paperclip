import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { DurablePrpControlPlane, decodeDurablePrpCheckpoint, type DurablePrpCheckpoint } from "./durable-prp-control-plane.js";

it("reserves bounded capacity only for settlement and preserves it across reload and checkpoint", async () => {
  const root = mkdtempSync("/Volumes/NVM/AI_Agent_Runtime/tmp/settlement-reserve-");
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
  const options = { stateDirectory: resolve(root, "control-plane"), identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` };
  const first = new DurablePrpControlPlane(options);
  let restored: DurablePrpControlPlane | undefined;
  try {
    for (let i = 0; i < 500; i++) first.queueCommand("runner.drain", { i }, `normal-${i}`);
    expect(() => first.queueCommand("runner.drain", {}, "normal-overflow")).toThrow(/command_journal_full/);
    expect(() => first.queueSettlementCommand("turn.start", {}, "forbidden")).toThrow(/invalid/);
    expect(() => first.queueSettlementCommand("session.close", { big: "x".repeat(1024 * 1024) }, "large")).toThrow(/command_payload_too_large/);
    const command = first.queueSettlementCommand("session.close", {}, "close");
    expect(first.queueSettlementCommand("session.close", {}, "close")).toEqual(command);
    expect(() => first.queueSettlementCommand("session.close", { changed: true }, "close")).toThrow(/conflicts/);
    for (let i = 1; i < 32; i++) first.queueSettlementCommand("semantic_tool.result", { i }, `settle-${i}`);
    expect(() => first.queueSettlementCommand("runner.suspend", {}, "overflow")).toThrow(/command_journal_full/);
    await first.stop();
    restored = new DurablePrpControlPlane(options);
    expect(restored.getCommand("close")).toEqual(command);
    expect(restored.queueSettlementCommand("session.close", {}, "close")).toEqual(command);
    let checkpoint!: DurablePrpCheckpoint;
    restored.setCheckpointPersistence(async saved => { checkpoint = saved; });
    await restored.flushCheckpoint();
    const records = new Map(checkpoint.records);
    expect(() => decodeDurablePrpCheckpoint(records)).not.toThrow();
    const bad = JSON.parse(records.get("command:501")!);
    bad.type = "turn.start";
    records.set("command:501", JSON.stringify(bad));
    expect(() => decodeDurablePrpCheckpoint(records)).toThrow(/native_runner_checkpoint_invalid/);
    await restored.stop();
    // Restore the valid checkpoint, then corrupt the reserved suffix on disk.
    rmSync(options.stateDirectory, { recursive: true, force: true });
    decodeDurablePrpCheckpoint(new Map(checkpoint.records)).restoreSessionDirectory(root);
    const path = resolve(options.stateDirectory, "control-plane-state.json");
    const state = JSON.parse(readFileSync(path, "utf8")); state.commands[500].type = "turn.start";
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    expect(() => new DurablePrpControlPlane(options)).toThrow(/state is invalid/);
  } finally {
    await restored?.stop(); await first.stop(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
