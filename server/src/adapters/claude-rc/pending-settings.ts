import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { applySeatSettings, isValidSeatSettings, rcSlot, rcSlotCount, reconcileIdleSeat } from "./execute.js";

type Agent = { id: string; adapterType: string; adapterConfig: unknown };
type Settings = { model: string; effort: string };
const prefix = "pending-settings-";
const value = (v: unknown, fallback: string) => typeof v === "string" && v.trim() ? v.trim() : fallback;
function config(agent: Agent) {
  const cfg = agent.adapterConfig && typeof agent.adapterConfig === "object" ? agent.adapterConfig as Record<string, unknown> : {};
  return { model: value(cfg.model, "claude-sonnet-5-5"), effort: value(cfg.effort, "medium"),
    socket: value(cfg.tmuxSocket, "pc-claude-rc"), session: value(cfg.tmuxSession, "claude"),
    stateDir: path.resolve(value(cfg.stateDir, path.join(os.homedir(), ".paperclip/claude-rc-state"))), slots: rcSlotCount(cfg.slots) };
}
const same = (a: Settings, b: Settings) => a.model === b.model && a.effort === b.effort;

// Called inside the configuration transaction: an intent survives a crash after commit.
export async function recordSettingsChange(before: Agent, after: Agent): Promise<void> {
  if (after.adapterType !== "claude_rc_local" || (before.adapterType === after.adapterType && same(config(before), config(after)))) return;
  const c = config(after);
  for (let i = 0; i < c.slots; i++) {
    const dir = rcSlot(i, c.session, c.stateDir).stateDir;
    if (!await fs.stat(dir).then(s => s.isDirectory()).catch(e => { if (e.code === "ENOENT") return false; throw e; })) continue;
    await fs.writeFile(path.join(dir, `${prefix}${randomUUID()}.json`), JSON.stringify({ model: c.model, effort: c.effort }), { mode: 0o600, flag: "wx" });
  }
}

export async function pendingMarkers(dir: string): Promise<Array<{ file: string; settings: Settings }>> {
  const names = await fs.readdir(dir).catch(e => { if (e.code === "ENOENT") return []; throw e; });
  const entries = await Promise.all(names.filter(n => n.startsWith(prefix) && n.endsWith(".json")).map(async n => {
    const file = path.join(dir, n);
    const settings = await fs.readFile(file, "utf8").then(t => JSON.parse(t) as Settings).catch(() => null);
    return settings ? { file, settings } : null;
  }));
  return entries.filter((entry): entry is { file: string; settings: Settings } => entry !== null);
}

export async function clearApplied(pending: Awaited<ReturnType<typeof pendingMarkers>>): Promise<void> {
  await Promise.all(pending.map(p => fs.rm(p.file, { force: true })));
}

export type PendingSnapshot = { agent: Agent | null; pending: Awaited<ReturnType<typeof pendingMarkers>> };
export async function clearDispatchApplied(inspect: () => Promise<PendingSnapshot>, applied: Settings): Promise<void> {
  const { agent, pending } = await inspect();
  if (agent?.adapterType === "claude_rc_local" && same(config(agent), applied)) await clearApplied(pending);
}

export async function attemptPending(dir: string, inspect: () => Promise<PendingSnapshot>,
  apply = applySeatSettings): Promise<boolean> {
  if (!(await pendingMarkers(dir)).length) return true;
  return reconcileIdleSeat({ stateDir: dir, readCurrent: inspect, apply: async ({ agent, pending }) => {
    if (!pending.length) return true;
    if (!agent) return false;
    if (agent.adapterType !== "claude_rc_local") return false;
    const c = config(agent);
    const slot = Array.from({ length: c.slots }, (_, i) => rcSlot(i, c.session, c.stateDir)).find(s => s.stateDir === dir);
    if (!slot || !isValidSeatSettings(c.model, c.effort) || !/^[a-zA-Z0-9_-]{1,55}$/.test(c.socket) || !/^[a-zA-Z0-9_-]{1,55}$/.test(slot.session)) return false;
    if (!await apply(c.socket, slot.session, dir, c.model, c.effort)) return false;
    await clearApplied(pending);
    return true;
  } });
}

export async function retryPending(attempt: () => Promise<boolean>, delay = () => new Promise<void>(resolve => setTimeout(resolve, 1000))): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (await attempt()) return;
    if (i < 9) await delay();
  }
}

export function settingsReconciler(db: Db, apply = applySeatSettings) {
  const read = (id: string) => db.select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents).where(eq(agents.id, id)).then(rows => rows[0] ?? null);
  // Configuration writers hold this row lock while creating their intent. Snapshotting
  // under the same lock excludes uncommitted or later changes from a clear.
  const inspect = (id: string, dir: string): Promise<PendingSnapshot> => db.transaction(async tx => {
    const rows = await tx.select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents).where(eq(agents.id, id)).for("no key update");
    return { agent: rows[0] ?? null, pending: await pendingMarkers(dir) };
  });
  async function attemptAgent(id: string) {
    const agent = await read(id);
    if (!agent || agent.adapterType !== "claude_rc_local") return true;
    const c = config(agent);
    const results = await Promise.all(Array.from({ length: c.slots }, (_, i) => {
      const dir = rcSlot(i, c.session, c.stateDir).stateDir;
      return attemptPending(dir, () => inspect(id, dir), apply);
    }));
    return results.every(Boolean);
  }
  return { inspect, attemptAgent,
    async boot() {
      const all = await db.select({ id: agents.id }).from(agents).where(eq(agents.adapterType, "claude_rc_local"));
      await Promise.all(all.map(a => attemptAgent(a.id)));
    },
  };
}
