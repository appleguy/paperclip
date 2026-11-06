import { modelEffortName, stripModelEffortWords } from "./model-effort-name.js";

/** Build a short display name without copying URLs or credential-like values into Codex. */
export function buildCodexSharedThreadName(input: {
  agentName: string;
  runId: string;
  issue?: { identifier: string; title: string } | null;
  wakeReason?: string | null;
  taskSummary?: string | null;
  model?: string | null;
  effort?: string | null;
}): string {
  const clean = (value: string) => value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, "[link]")
    .replace(/\b(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi, "[redacted]")
    .replace(/\b(?:sk|ghp|github_pat)-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ").trim();
  const limit = (value: string, max: number) => Array.from(value).slice(0, Math.max(0, max)).join("").trimEnd();
  const originalAgent = clean(input.agentName) || "Agent";
  const tag = modelEffortName("codex", input.model, input.effort);
  const prefix = tag ? `${tag} ` : "";
  const agent = clean(stripModelEffortWords(originalAgent.replace(/\([^)]*\)/g, " "), "codex", input.model, input.effort)
    .replace(/\b(?:codex|worker|low|medium|high|xhigh|max)\b/gi, " ")) || (tag ? "Agent" : originalAgent);
  const suffix = ` · ${limit(agent, 76 - Array.from(prefix).length)}`;
  const available = 80 - Array.from(suffix).length - Array.from(prefix).length;
  const title = (value: string) => clean(value).replace(/^(?:owner ask)\s*:\s*/i, "").trim();
  if (!input.issue) {
    const summary = title(input.taskSummary || "") || clean(input.wakeReason || "").replace(/[_-]+/g, " ") || `run ${clean(input.runId).slice(0, 6)}`;
    return prefix + limit(summary, available) + suffix;
  }
  const identifier = limit(clean(input.issue.identifier) || "Issue", available);
  const issueTitle = title(input.issue.title);
  const rest = limit(issueTitle, available - Array.from(identifier).length - 1);
  return prefix + identifier + (rest ? ` ${rest}` : "") + suffix;
}
