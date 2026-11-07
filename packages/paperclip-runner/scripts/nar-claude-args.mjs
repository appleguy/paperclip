// Subscription auth: no --bare (it requires an API key). The CLAUDE.md chain already carries the Guidance owner rules,
// so only class layers are appended. /goal is a slash command, so commands stay enabled when a goal is queued.
export function claudeResumeArgs(sessionId, extraGuidance, prompt) {
  return ['--setting-sources', '', ...(prompt ? [] : ['--disable-slash-commands']),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', ...(extraGuidance ? ['--append-system-prompt', extraGuidance] : []),
    '--resume', sessionId, ...(prompt ? [prompt] : [])];
}
