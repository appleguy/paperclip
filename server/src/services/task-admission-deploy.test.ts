import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { deployOwnerLiveness, localProcessBirth } from "./deploy-owner.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { applyTaskDrain, computeTaskDrain, isIdleTaskDrainActive, readTaskDrain,
  reclaimDeadDeployOwner, registerTaskDrainExpiryWork, stopTaskDrain, withTaskDrainTransition } from "./task-admission.js";

afterEach(() => stopTaskDrain());

describe("deploy drain owner", () => {
  it("uses a real process identity and reclaims after the owner dies", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const owner = { pid: child.pid!, birth: await localProcessBirth(child.pid!) };
      expect(await deployOwnerLiveness(owner)).toBe("alive");
      applyTaskDrain(computeTaskDrain({ purpose: "deploy", ownerId: "owner-a", deployOwner: owner }));
      expect(isIdleTaskDrainActive()).toBe(false);
      expect(await reclaimDeadDeployOwner()).toBe(false);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(await reclaimDeadDeployOwner()).toBe(true);
      expect(readTaskDrain(new Date())).toBeNull();
    } finally { child.kill("SIGKILL"); }
  });

  it("does not clear a replacement installed while reclamation waits for the transition", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const owner = { pid: child.pid!, birth: await localProcessBirth(child.pid!) };
      applyTaskDrain(computeTaskDrain({ purpose: "deploy", ownerId: "old", deployOwner: owner }));
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const replacement = withTaskDrainTransition(async () => {
        entered();
        await gate;
        applyTaskDrain(computeTaskDrain({ purpose: "idle", ttlMs: 60_000 }));
      });
      await ready;
      let probed!: () => void;
      const probeFinished = new Promise<void>(resolve => { probed = resolve; });
      const reclaim = reclaimDeadDeployOwner(async identity => {
        const result = await deployOwnerLiveness(identity);
        probed();
        return result;
      });
      await probeFinished;
      await Promise.resolve();
      release();
      await replacement;
      expect(await reclaim).toBe(false);
      expect(isIdleTaskDrainActive()).toBe(true);
    } finally { child.kill("SIGKILL"); }
  });

  it("recognizes a different birth for a reused PID without releasing a matching live owner", async () => {
    const birth = await localProcessBirth(process.pid);
    expect(await deployOwnerLiveness({ pid: process.pid, birth })).toBe("alive");
    expect(await deployOwnerLiveness({ pid: process.pid, birth: `${birth}-different` })).toBe("dead");
  });

  it("retains a fence when the process observation is inconclusive", async () => {
    const owner = { pid: process.pid, birth: await localProcessBirth(process.pid) };
    const drain = computeTaskDrain({ purpose: "deploy", ownerId: "owner", deployOwner: owner });
    applyTaskDrain(drain);
    expect(await reclaimDeadDeployOwner(async () => "unknown")).toBe(false);
    expect(readTaskDrain(new Date())).toBe(drain);
  });

  it("reconciles a dead owner through the real coordinator and resumes admission", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const execute = async () => [];
    const transaction = async () => { throw new Error("unexpected transaction"); };
    const coordinator = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }),
      canRun: () => false, canReconcile: () => true, onError: error => { throw error; } });
    let resumed!: () => void;
    const released = new Promise<void>(resolve => { resumed = resolve; });
    const worker = registerTaskDrainExpiryWork(coordinator, resumed);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await worker.ready;
      const owner = { pid: child.pid!, birth: await localProcessBirth(child.pid!) };
      applyTaskDrain(computeTaskDrain({ purpose: "deploy", ownerId: "owner", deployOwner: owner }));
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await Promise.race([released, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("owner cleanup did not run")), 10_000);
      })]);
      expect(readTaskDrain(new Date())).toBeNull();
    } finally {
      if (deadline) clearTimeout(deadline);
      child.kill("SIGKILL");
      await worker.stop();
      await coordinator.stop();
    }
  }, 15_000);
});
