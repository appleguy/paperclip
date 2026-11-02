/** Build a short display name without copying URLs or credential-like values into Codex. */
export function buildCodexSharedThreadName(input: {
  agentName: string;
  runId: string;
  issue?: { identifier: string; title: string } | null;
}): string {
  const clean = (value: string) => value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, "[link]")
    .replace(/\b(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/gi, "[redacted]")
    .replace(/\b(?:sk|ghp|github_pat)-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/\s+/g, " ").trim();
  const limit = (value: string, max: number) => Array.from(value).slice(0, Math.max(0, max)).join("").trimEnd();
  const agent = clean(input.agentName) || "Agent";
  if (!input.issue) {
    const suffix = ` · run ${clean(input.runId).slice(0, 8)}`;
    return limit(agent, 80 - Array.from(suffix).length) + suffix;
  }
  const identifier = clean(input.issue.identifier) || "Issue";
  // Shorten the title first; only unusually long identifiers or agent names
  // need shortening to leave room for a title.
  const shortIdentifier = limit(identifier, 35);
  const prefix = `${shortIdentifier} · ${limit(agent, 73 - Array.from(shortIdentifier).length)} · `;
  return prefix + limit(clean(input.issue.title), 80 - Array.from(prefix).length);
}
