import { randomUUID } from "node:crypto";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { deployOwnerLiveness, type DeployOwner } from "./deploy-owner.js";

export type TaskDrainState = { startedAt: Date; expiresAt: Date | null; ownerId?: string; purpose?: "idle" | "deploy"; deployOwner?: DeployOwner };
let taskDrainState: TaskDrainState | null = null;
const expiryListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
let taskDrainTransitionQueue: Promise<void> = Promise.resolve();
export function withTaskDrainTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = trackIdleWork(taskDrainTransitionQueue.then(run));
  taskDrainTransitionQueue = turn.then(() => undefined, () => undefined);
  return turn;
}

// Recheck only while an actual deploy owns a fence. Liveness probes happen
// outside the transition queue; the exact state object is compared inside it.
export async function reclaimDeadDeployOwner(probe = deployOwnerLiveness) {
  const candidate = readTaskDrain(new Date());
  if (!candidate?.deployOwner || await probe(candidate.deployOwner) !== "dead") return false;
  return withTaskDrainTransition(async () => {
    if (readTaskDrain(new Date()) !== candidate) return false;
    taskDrainState = null;
    notifyDrainChanged();
    notifyExpiry();
    return true;
  });
}

function notifyExpiry() {
  for (const listener of expiryListeners) {
    try { listener(); } catch (error) { process.emitWarning(`Task drain expiry notification failed: ${String(error)}`); }
  }
}

function notifyDrainChanged() {
  for (const listener of changeListeners) listener();
}
export function subscribeTaskDrainChanges(listener: () => void) {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

// The shared coordinator owns this process-local deadline and its shutdown.
// Reading admission can also establish expiry, so both paths notify the same
// listener. No database scan or recurring timer is needed while idle.
export function registerTaskDrainExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  onExpired: () => void,
) {
  const worker = coordinator.register(DELIVERY_QUEUES.taskDrainExpiry, {
    retryMs: 1000,
    runDuringDrain: true,
    run: async () => { readTaskDrain(new Date()); await reclaimDeadDeployOwner(); },
    hasPending: async () => false,
    nextRunAt: () => {
      const expiry = taskDrainState?.expiresAt?.getTime() ?? null;
      const ownerCheck = taskDrainState?.deployOwner ? Date.now() + 1000 : null;
      return expiry === null ? ownerCheck : ownerCheck === null ? expiry : Math.min(expiry, ownerCheck);
    },
  });
  expiryListeners.add(onExpired);
  changeListeners.add(worker.wake);
  return {
    ready: worker.ready,
    async stop() {
      changeListeners.delete(worker.wake);
      expiryListeners.delete(onExpired);
      await worker.stop();
    },
  };
}

export function readTaskDrain(now: Date): TaskDrainState | null {
  if (taskDrainState?.expiresAt && taskDrainState.expiresAt.getTime() <= now.getTime()) {
    taskDrainState = null;
    notifyExpiry();
  }
  return taskDrainState;
}

export function computeTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" | "deploy"; ownerId?: string; deployOwner?: DeployOwner } = {}): TaskDrainState {
  const startedAt = new Date();
  return { startedAt, expiresAt: opts.ttlMs == null ? null : new Date(startedAt.getTime() + opts.ttlMs),
    ...(opts.purpose === "idle" ? { purpose: "idle" as const, ownerId: randomUUID() } : {}),
    ...(opts.purpose === "deploy" ? { purpose: "deploy" as const, ownerId: opts.ownerId, deployOwner: opts.deployOwner } : {}) };
}

export function applyTaskDrain(drain: TaskDrainState): void {
  taskDrainState = drain;
  notifyDrainChanged();
}
export function startTaskDrain(opts: { ttlMs?: number | null; purpose?: "idle" } = {}): TaskDrainState {
  const drain = computeTaskDrain(opts);
  applyTaskDrain(drain);
  return drain;
}
export function stopTaskDrain(): { wasActive: boolean } {
  const wasActive = readTaskDrain(new Date()) !== null;
  taskDrainState = null;
  notifyDrainChanged();
  return { wasActive };
}
export function isIdleTaskDrainActive(): boolean { return readTaskDrain(new Date())?.purpose === "idle"; }

// Tokens count work until its actual promise settles, including after HTTP
// disconnects and after a cleanup batch has been removed from its input queue.
// The generation also catches work which starts AND finishes during a scan.
let generation = 0;
let active = 0;
export function beginIdleTrackedWork(): () => void {
  generation++;
  active++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    active--;
    generation++;
  };
}
export function trackIdleWork<T>(work: Promise<T>): Promise<T> {
  const finish = beginIdleTrackedWork();
  return work.finally(finish);
}
export function idleWorkSnapshot() { return { generation, active }; }
