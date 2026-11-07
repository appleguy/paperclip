// Subscription auth: no --bare (it requires an API key). The CLAUDE.md chain already carries the Guidance owner rules,
// so only class layers are appended. /goal is a slash command, so commands stay enabled when a goal is queued.
// A named seat resumes with Remote Control and skip-permissions (owner rule for every seat), plus its registered model/effort.
export function claudeResumeArgs(sessionId, extraGuidance, prompt, seat = {}) {
  return ['--setting-sources', '', ...(prompt ? [] : ['--disable-slash-commands']),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', ...(extraGuidance ? ['--append-system-prompt', extraGuidance] : []),
    ...(seat.name ? ['--remote-control', seat.name, '--name', seat.name, '--dangerously-skip-permissions'] : []),
    ...(seat.model ? ['--model', seat.model] : []), ...(seat.effort ? ['--effort', seat.effort] : []),
    '--resume', sessionId, ...(prompt ? [prompt] : [])];
}

/** Fresh NAR Claude seat: same zero settings/MCP as resume, a fixed session id so the seat can be resumed, Remote Control on. */
export function claudeStartArgs({ sessionId, name, model, effort, extraGuidance, prompt }) {
  return ['--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', ...(extraGuidance ? ['--append-system-prompt', extraGuidance] : []),
    '--session-id', sessionId, '--remote-control', name, '--name', name, '--model', model, '--effort', effort,
    '--dangerously-skip-permissions', prompt];
}
