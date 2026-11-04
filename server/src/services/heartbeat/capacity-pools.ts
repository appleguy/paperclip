import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../../home-paths.js";
import { parseObject } from "../../adapters/utils.js";

// Capacity pools separate roles (N agents) from capacity (M slots). Agents opt in
// with runtimeConfig.capacityPool; the registry file maps pool name to
// { limit, statusUrl? }. When statusUrl is set, its JSON `slots` is the live M and
// `limit` is the fallback. A pool with neither is not enforced.
export interface CapacityPoolDef {
  limit?: number;
  statusUrl?: string;
}

const STATUS_TTL_MS = 10_000;
const REGISTRY_TTL_MS = 5_000;
let registryCache: { at: number; pools: Record<string, CapacityPoolDef> } | null = null;
const statusCache = new Map<string, { at: number; slots: number | null }>();

export function agentCapacityPool(agent: { runtimeConfig?: unknown }): string | null {
  const name = parseObject(agent.runtimeConfig).capacityPool;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

async function loadRegistry(): Promise<Record<string, CapacityPoolDef>> {
  const now = Date.now();
  if (registryCache && now - registryCache.at < REGISTRY_TTL_MS) return registryCache.pools;
  const file = process.env.PAPERCLIP_CAPACITY_POOLS_FILE ?? path.join(resolvePaperclipHomeDir(), "capacity-pools.json");
  let pools: Record<string, CapacityPoolDef> = {};
  try {
    pools = parseObject(JSON.parse(await readFile(file, "utf8"))) as Record<string, CapacityPoolDef>;
  } catch {
    // Missing or malformed registry: no pool is enforced.
  }
  registryCache = { at: now, pools };
  return pools;
}

async function liveSlots(url: string): Promise<number | null> {
  const hit = statusCache.get(url);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.slots;
  let slots: number | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const n = Number((await res.json() as { slots?: unknown }).slots);
    if (res.ok && Number.isFinite(n) && n >= 0) slots = Math.floor(n);
  } catch {
    // Fall back to the configured limit.
  }
  statusCache.set(url, { at: Date.now(), slots });
  return slots;
}

/** Slot count M for a pool, or null when the pool is not enforced. */
export async function resolvePoolLimit(pool: string): Promise<number | null> {
  const def = (await loadRegistry())[pool];
  if (!def) return null;
  const live = def.statusUrl ? await liveSlots(def.statusUrl) : null;
  const limit = live ?? (typeof def.limit === "number" && def.limit >= 0 ? Math.floor(def.limit) : null);
  return limit;
}

export async function listPoolNames(): Promise<string[]> {
  return Object.keys(await loadRegistry());
}
