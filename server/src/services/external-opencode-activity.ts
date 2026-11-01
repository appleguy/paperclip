/**
 * Advisory external OpenCode activity. This never owns a Paperclip heartbeat,
 * run, checkout, token ledger, agent status or provider mutation credential.
 *
 * Install-specific opt-in: PAPERCLIP_EXTERNAL_ZTOP_COMPANY_ID must match the
 * requesting company exactly. No path, endpoint or session is user supplied.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const OBSERVER = fileURLToPath(new URL("./scripts/external-presence/observe.mjs", import.meta.url));
const STABLE_ID = "external/mac-pro/ztop/maya-l-medium";
const STATUSES = new Set(["observed_active", "handoff", "idle", "stale", "unverified"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExternalOpenCodeActivity = {
  stableExternalId: string;
  kind: "external_opencode_activity";
  authority: "observer_only";
  modelLabel: string;
  backend: string;
  status: "observed_active" | "handoff" | "idle" | "stale" | "unverified";
  backendVerified: boolean;
  currentSessionId: string;
  sessionLineage: string[];
  committedHandoffCount: number;
  handoffLimitReached: boolean;
  guardPhase: string;
  lastNativeEventAt: string;
  observedAt: string;
  paperclipRunId: null;
  paperclipAgentId: null;
  paperclipTaskCheckout: false;
  claim: "advisory_presence_not_managed_execution";
};

type ObserverRunner = () => Promise<string>;
const runObserver: ObserverRunner = async () => {
  const { stdout } = await execFileAsync(process.execPath, [OBSERVER], {
    timeout: 5_000,
    maxBuffer: 24 * 1024,
    windowsHide: true,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/var/empty" },
  });
  return stdout;
};

/** Discard malformed/unscoped provider output, never expose raw files or errors. */
export function parseExternalActivity(raw: string): ExternalOpenCodeActivity | null {
  let item: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    item = candidate as Record<string, unknown>;
  } catch {
    return null;
  }
  if (item.stableExternalId !== STABLE_ID ||
      item.kind !== "external_opencode_activity" ||
      item.authority !== "observer_only" ||
      !STATUSES.has(String(item.status)) ||
      item.paperclipRunId !== null ||
      item.paperclipAgentId !== null ||
      item.paperclipTaskCheckout !== false ||
      item.claim !== "advisory_presence_not_managed_execution" ||
      typeof item.backendVerified !== "boolean" ||
      (item.backendVerified === false && item.status !== "unverified") ||
      typeof item.currentSessionId !== "string" ||
      !/^ses_[A-Za-z0-9_]{10,100}$/.test(item.currentSessionId) ||
      !Array.isArray(item.sessionLineage) ||
      item.sessionLineage.length < 1 || item.sessionLineage.length > 20 ||
      item.sessionLineage.at(-1) !== item.currentSessionId ||
      !item.sessionLineage.every(id => typeof id === "string" && /^ses_[A-Za-z0-9_]{10,100}$/.test(id)) ||
      typeof item.committedHandoffCount !== "number" ||
      item.committedHandoffCount !== item.sessionLineage.length - 1 ||
      typeof item.handoffLimitReached !== "boolean" ||
      typeof item.guardPhase !== "string" ||
      typeof item.observedAt !== "string" ||
      !Number.isFinite(Date.parse(item.observedAt)) ||
      typeof item.lastNativeEventAt !== "string" ||
      !Number.isFinite(Date.parse(item.lastNativeEventAt))) return null;
  return {
    stableExternalId: STABLE_ID,
    kind: "external_opencode_activity",
    authority: "observer_only",
    modelLabel: "GLM-5.3 Flash · Maya-L Medium",
    backend: "OpenCode v2.2.2",
    status: item.status as ExternalOpenCodeActivity["status"],
    backendVerified: item.backendVerified,
    currentSessionId: item.currentSessionId,
    sessionLineage: item.sessionLineage as string[],
    committedHandoffCount: item.committedHandoffCount,
    handoffLimitReached: item.handoffLimitReached,
    guardPhase: item.guardPhase.slice(0, 32),
    lastNativeEventAt: item.lastNativeEventAt,
    observedAt: item.observedAt,
    paperclipRunId: null,
    paperclipAgentId: null,
    paperclipTaskCheckout: false,
    claim: "advisory_presence_not_managed_execution",
  };
}

/** Company ACL is enforced by the route before this source-scoping check. */
export async function listExternalOpenCodeActivity(
  companyId: string,
  options: { configuredCompanyId?: string; runner?: ObserverRunner } = {},
): Promise<ExternalOpenCodeActivity[]> {
  const allowed = options.configuredCompanyId ?? process.env.PAPERCLIP_EXTERNAL_ZTOP_COMPANY_ID;
  if (!allowed || !UUID.test(allowed) || companyId !== allowed) return [];
  try {
    const candidate = parseExternalActivity(await (options.runner ?? runObserver)());
    return candidate ? [candidate] : [];
  } catch {
    // Provider is not independently proven: don't fabricate an agent as running.
    return [];
  }
}
