// Subscription auth: no --bare (it requires an API key). The CLAUDE.md chain already carries the Guidance owner rules,
// so only class layers are appended. /goal is a slash command, so commands stay enabled when a goal is queued.
// A named seat resumes with Remote Control and skip-permissions (owner rule for every seat), plus its registered model/effort.
// Tool schemas are ~17k of the 20k zero-settings baseline; a seat never needs these (measured 20463 -> ~9.5k first turn).
const UNUSED_TOOLS = ['Artifact', 'ArtifactComments', 'ArtifactData', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree',
  'EnterPlanMode', 'ExitPlanMode', 'DesignSync', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'Workflow',
  'PushNotification', 'EndConversation', 'ListAgents', 'FetchInboxMessage', 'ReadNotifications', 'ReportFindings', 'SendFeedback',
  // Deferred-tool list and subagent listing attachments ride in every turn (and after /compact) while any of these exist.
  'Monitor', 'SendMessage', 'TaskStop', 'WebSearch', 'Agent', 'ToolSearch'];

export function claudeResumeArgs(sessionId, extraGuidance, prompt, seat = {}) {
  return ['--setting-sources', '', '--disallowedTools', UNUSED_TOOLS.join(','), ...(prompt?.startsWith('/') ? [] : ['--disable-slash-commands']),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', ...(extraGuidance ? ['--append-system-prompt', extraGuidance] : []),
    ...(seat.name ? ['--remote-control', seat.name, '--name', seat.name, '--dangerously-skip-permissions'] : []),
    ...(seat.model ? ['--model', seat.model] : []), ...(seat.effort ? ['--effort', seat.effort] : []),
    '--resume', sessionId, ...(prompt ? [prompt] : [])];
}

/** Fresh NAR Claude seat: same zero settings/MCP as resume, a fixed session id so the seat can be resumed, Remote Control on. */
export function claudeStartArgs({ sessionId, name, model, effort, extraGuidance, prompt }) {
  return ['--setting-sources', '', '--disallowedTools', UNUSED_TOOLS.join(','), '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', ...(extraGuidance ? ['--append-system-prompt', extraGuidance] : []),
    '--session-id', sessionId, '--remote-control', name, '--name', name, '--model', model, '--effort', effort,
    '--dangerously-skip-permissions', prompt];
}
