import type { ServerAdapterModule } from "../types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execute } from "./execute.js";
const run = promisify(execFile);

export const claudeRcAdapter: ServerAdapterModule = {
  type: "claude_rc_local",
  runtimeToolDelivery: "environment",
  execute,
  testEnvironment: async () => {
    const checks: Array<{ code: string; level: "info" | "error"; message: string }> = [];
    for (const [command, args, label] of [
      ["/opt/homebrew/bin/claude", ["--version"], "claude"],
      ["/opt/homebrew/bin/tmux", ["-V"], "tmux"],
    ] as const) {
      try {
        const output = await run(command, args, { timeout: 7000 });
        checks.push({ code: label, level: "info", message: `${label}: ${output.stdout.trim()}` });
      } catch {
        checks.push({ code: label, level: "error", message: `${label} missing or unavailable on Mac Pro` });
      }
    }
    return { adapterType: "claude_rc_local", status: checks.some(c => c.level === "error") ? "fail" : "pass",
      testedAt: new Date().toISOString(), checks };
  },
  models: [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet via shared Remote Control session" },
    { id: "claude-haiku-5-5", label: "Claude Haiku via shared Remote Control session" },
  ],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  agentConfigurationDoc: `# claude_rc_local: one shared interactive Claude Code Remote Control session

claude --print ignores --remote-control, so phone visibility needs the
interactive TUI. One persistent tmux pane runs
claude --remote-control <name> --name <name>; the owner sees and steers that
same session from the Claude app. Turns are serialized; each issue gets /clear
(new transcript UUID = Paperclip sessionId). Background tool tasks are disabled.

Config: cwd, stateDir, tmuxSocket (pc-claude-rc), tmuxSession (claude),
remoteControlName (Paperclip Claude), model (claude-sonnet-5-5|claude-haiku-5-5),
effort (low|medium|high, default medium), expectedRemoteControlUrl, timeoutSec.

The agent writes a JSON receipt; the adapter publishes the report and closes the
issue with the run token. A same-issue active.json is adopted after a server
restart without re-sending; any other unresolved checkpoint blocks dispatch.
`,
  getConfigSchema: () => ({
    fields: [
      { key: "cwd", label: "Shared trusted workspace", type: "text" },
      { key: "stateDir", label: "Private dispatch/receipt directory", type: "text" },
      { key: "tmuxSocket", label: "tmux server socket", type: "text", default: "pc-claude-rc" },
      { key: "tmuxSession", label: "tmux session", type: "text", default: "claude" },
      { key: "remoteControlName", label: "Remote Control session name", type: "text", default: "Paperclip Claude" },
      { key: "effort", label: "Effort", type: "text", default: "medium" },
      { key: "expectedRemoteControlUrl", label: "Expected RC session URL", type: "text" },
      { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 900 },
    ],
  }),
};
