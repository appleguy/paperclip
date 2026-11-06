import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

const key = "paperclipIssueScopeV1";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function codexIssueScope(context: Record<string, unknown>) {
  const issueId = nonempty(record(context.paperclipIssue).id) ?? nonempty(context.issueId);
  return issueId ? { issueId, projectId: nonempty(context.projectId) } : null;
}

export function copyCodexIssueScope(params: Record<string, unknown>, source: Record<string, unknown>) {
  const scope = record(source[key]);
  const issueId = nonempty(scope.issueId), projectId = nonempty(scope.projectId);
  return issueId && projectId ? { ...params, [key]: { issueId, projectId } } : params;
}

export function prepareCodexIssueSession(ctx: AdapterExecutionContext) {
  const scope = codexIssueScope(ctx.context);
  if (!scope) return { ctx, scope: null };
  const stored = record(record(ctx.runtime.sessionParams)[key]);
  const matches = scope.projectId !== null && stored.issueId === scope.issueId && stored.projectId === scope.projectId;
  const scopedContext = matches ? ctx : {
    ...ctx,
    runtime: { ...ctx.runtime, sessionId: null, sessionDisplayId: null, sessionParams: null },
    executionContinuation: ctx.executionContinuation ? { ...ctx.executionContinuation, resumeDelta: undefined } : ctx.executionContinuation,
  };
  return { ctx: scopedContext, scope };
}

export function stampCodexIssueSession<T extends { sessionParams?: Record<string, unknown> | null }>(value: T, scope: ReturnType<typeof codexIssueScope>): T {
  if (!scope?.projectId || !value.sessionParams) return value;
  return { ...value, sessionParams: { ...value.sessionParams, [key]: scope } };
}

export function stampCodexIssueResult(result: AdapterExecutionResult, scope: ReturnType<typeof codexIssueScope>) {
  return result.clearSession ? result : stampCodexIssueSession(result, scope);
}
