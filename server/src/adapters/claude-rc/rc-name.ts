/**
 * (SCO-818: first hot-deployed module; this line shipped without a server restart.)
 * SCO-782: the Remote Control name is derived, never configured:
 * "<hops below Board> <Paperclip agent name>", sanitized and capped.
 * A bad name is repaired, never a reason to fail a wake.
 */
const DISALLOWED = /[^A-Za-z0-9 ._-]+/g;
export const RC_NAME_MAX = 60;
export const RC_NAME_FALLBACK = "Paperclip Claude";

export function sanitizeRcName(raw: string): string {
  const s = raw.replace(DISALLOWED, " ").replace(/\s+/g, " ").trim().slice(0, RC_NAME_MAX).trim();
  return s || RC_NAME_FALLBACK;
}

export interface RcAgentNode { id: string; name: string; reportsTo?: string | null }

/** reportsTo hops to the root (Board = 0). Cycle- and gap-safe: stops at the first unknown or repeated id. */
export function reportsToDepth(agentId: string, agents: RcAgentNode[]): number {
  const byId = new Map(agents.map(a => [a.id, a]));
  const seen = new Set<string>();
  let depth = 0;
  let cur = byId.get(agentId);
  while (cur?.reportsTo && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = byId.get(cur.reportsTo);
  }
  return depth;
}

/** SCO-965: seats beyond slot 0 carry " s<k>" so each Remote Control session is distinguishable; the suffix survives the cap. */
export function slotRcName(name: string, slot: number): string {
  if (!(slot > 0)) return name;
  const suffix = ` s${Math.floor(slot)}`;
  return `${name.slice(0, RC_NAME_MAX - suffix.length).trim()}${suffix}`;
}

export function deriveRcName(agentName: string, depth: number, slot = 0): string {
  const d = Number.isFinite(depth) && depth >= 0 ? Math.floor(depth) : 0;
  return slotRcName(sanitizeRcName(`${d} ${agentName}`), slot);
}
