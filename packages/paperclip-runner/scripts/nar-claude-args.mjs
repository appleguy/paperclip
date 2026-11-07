/** CLI 2.1.311: --bare disables discovery/hooks; explicitly disable skills and MCP too. */
export function claudeResumeArgs(sessionId, guidance, prompt) {
  return ['--bare', '--setting-sources', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt-snapshot', 'off', '--append-system-prompt', guidance, '--resume', sessionId, ...(prompt ? [prompt] : [])];
}
