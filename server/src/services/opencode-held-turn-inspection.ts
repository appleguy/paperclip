import { agents, heartbeatRuns } from "@paperclipai/db";
import { inspectBoundOpenCodeTurn } from "@paperclipai/adapter-opencode-local/server";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">;
type Inspection = Awaited<ReturnType<typeof inspectBoundOpenCodeTurn>>;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read-only observation. It cannot authorize a Stop, release, or retry. */
export async function inspectHeldOpenCodeRun(input: {
  run: Run; agent: Agent | null;
  loadRun: () => Promise<Run | null>; loadAgent: () => Promise<Agent | null>;
  inspect?: typeof inspectBoundOpenCodeTurn; now?: () => number;
}): Promise<Inspection> {
  const unknown = (reason: string): Inspection => ({ state: "unverified", reason });
  const { run, agent } = input;
  const now = input.now ?? Date.now;
  if (!agent || agent.id !== run.agentId || agent.companyId !== run.companyId || agent.adapterType !== "opencode_local" ||
      run.runtimeMode !== "legacy" || !(run.status === "running" || (run.status === "failed" && run.errorCode === "process_lost")))
    return unknown("run_not_eligible");
  if (!run.controllerBootId || !run.controllerLeaseExpiresAt || !Number.isFinite(run.controllerLeaseExpiresAt.getTime()) || run.controllerLeaseExpiresAt.getTime() > now())
    return unknown("controller_not_expired_or_unknown");
  const config = obj(agent.adapterConfig);
  const configPath = config.sharedServerRecoveryConfigPath;
  if (config.nativeRuntime !== "nar" || typeof configPath !== "string" || !configPath)
    return unknown("adapter_config_changed_or_unknown");
  const context = obj(run.contextSnapshot), result = obj(run.resultJson), earlySession = obj(result.earlySession);
  const contextIssue = typeof context.issueId === "string" && context.issueId ? context.issueId : null;
  if (run.issueId && contextIssue && run.issueId !== contextIssue) return unknown("task_scope_changed");
  const taskId = run.issueId ?? contextIssue ?? `agent-${run.agentId}`;
  const cwd = obj(earlySession.sessionParams).cwd;
  if (typeof cwd !== "string" || !cwd) return unknown("binding_invalid_or_unowned");
  const observed = await (input.inspect ?? inspectBoundOpenCodeTurn)({
    runId: run.id, agentId: run.agentId, taskId, cwd, configPath, earlySession,
  });
  const [latest, latestAgent] = await Promise.all([input.loadRun(), input.loadAgent()]);
  if (!latest || !latestAgent || latest.id !== run.id || latest.companyId !== run.companyId || latest.agentId !== run.agentId ||
      latest.status !== run.status || latest.errorCode !== run.errorCode || latest.runtimeMode !== run.runtimeMode || latest.scopeKind !== run.scopeKind ||
      latest.controllerBootId !== run.controllerBootId ||
      latest.controllerLeaseExpiresAt?.getTime() !== run.controllerLeaseExpiresAt.getTime() ||
      !latest.controllerLeaseExpiresAt || latest.controllerLeaseExpiresAt.getTime() > now() ||
      latest.issueId !== run.issueId || JSON.stringify(latest.contextSnapshot) !== JSON.stringify(run.contextSnapshot) ||
      JSON.stringify(obj(latest.resultJson).earlySession) !== JSON.stringify(result.earlySession) ||
      latestAgent.id !== agent.id || latestAgent.companyId !== agent.companyId || latestAgent.adapterType !== agent.adapterType ||
      JSON.stringify(latestAgent.adapterConfig) !== JSON.stringify(agent.adapterConfig))
    return unknown("ownership_or_binding_changed");
  return observed;
}
