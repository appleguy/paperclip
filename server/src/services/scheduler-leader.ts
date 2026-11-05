import { acquireSessionAdvisoryLock, type Db, type SessionAdvisoryLock } from "@paperclipai/db";

export const SCHEDULER_LEADER_LOCK_NAME = "paperclip:scheduler-leader";

export interface SchedulerLeadershipOptions {
  /** Off by default: a single server never waits and takes no lock. */
  enabled: boolean;
  signal?: AbortSignal;
  /** Called once if leadership is lost while held. Another server may be leading. */
  onLost?: (err: unknown) => void;
  log?: { info(obj: object, msg: string): void };
  /** Test seam for the lock primitive. */
  acquire?: typeof acquireSessionAdvisoryLock;
}

/**
 * Resolves once this server may run the scheduler: heartbeats, wake dispatch,
 * timers, queued-run resume and run adoption. With rolling replacement the
 * incoming server can bind its HTTP listener and migrate while the outgoing
 * server still owns those loops; it then waits here, and takes over when the
 * outgoing server releases the lock or exits. Returns null when disabled.
 */
export async function awaitSchedulerLeadership(
  db: Db,
  options: SchedulerLeadershipOptions,
): Promise<SessionAdvisoryLock | null> {
  if (!options.enabled) return null;
  const acquire = options.acquire ?? acquireSessionAdvisoryLock;
  options.log?.info({}, "waiting for scheduler leadership");
  const lock = await acquire(db, SCHEDULER_LEADER_LOCK_NAME, {
    signal: options.signal,
    onLost: options.onLost,
  });
  options.log?.info({}, "scheduler leadership acquired");
  return lock;
}
