import type { ServerAdapterModule } from "../types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execute as builtinExecute } from "./execute.js";
import { hotImport } from "../../hot/hot-modules.js";
import type { AdapterExecutionContext } from "../types.js";
const run = promisify(execFile);

// SCO-818: hot-deployable. New calls use the hot payload copy when one is active.
export const HOT_REL = "adapters/claude-rc/execute.js";
const execute = async (ctx: AdapterExecutionContext) =>
  (await hotImport(HOT_REL, async () => ({ execute: builtinExecute }))).execute(ctx);

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
  // The tmux session outlives the server; execute() adopts active.json without re-dispatch.
  supportsRestartReattach: true,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  agentConfigurationDoc: `# claude_rc_local: one shared interactive Claude Code Remote Control session

claude --print ignores --remote-control, so phone visibility needs the
interactive TUI. One persistent tmux pane runs
claude --remote-control <name> --name <name>; the owner sees and steers that
same session from the Claude app. Turns are serialized; each issue gets /clear
(new transcript UUID = Paperclip sessionId). Background tool tasks are disabled.

Primary input is the private pcbridge MCP channel, submitted via stdin (no prompt
in argv). --mcp-config loads it, and --settings installs local observation hooks.
--strict-mcp-config is deliberately OMITTED to preserve other configured MCPs.
[ASSUMPTION] The experimental --dangerously-load-development-channels
server:pcbridge flag remains compatible with the installed Claude Code 2.1.x.

The Remote Control name is derived at launch ("<hops below Board> <agent name>", sanitized, max 60);
any remoteControlName config is ignored.
Config: cwd, stateDir, tmuxSocket (pc-claude-rc), tmuxSession (claude),
model (claude-sonnet-5-5|claude-haiku-5-5),
effort (low|medium|high, default medium), expectedRemoteControlUrl, timeoutSec,
channelBridgeRoot (optional repository package directory).

The agent writes a JSON receipt; only the adapter publishes the report and
closes the issue with the run token. The bridge needs UserPromptSubmit hook
observation, not just a local write, before claiming accepted input.
If the channel is unavailable before any submission, a guarded tmux fallback
requires an empty idle editor. An uncertain submission always HOLDS and never
replays. A same-issue active.json is adopted after restart without re-sending;
any other unresolved checkpoint blocks dispatch.
`,
  getConfigSchema: () => ({
    fields: [
      { key: "cwd", label: "Shared trusted workspace", type: "text" },
      { key: "stateDir", label: "Private dispatch/receipt directory", type: "text" },
      { key: "tmuxSocket", label: "tmux server socket", type: "text", default: "pc-claude-rc" },
      { key: "tmuxSession", label: "tmux session", type: "text", default: "claude" },
      { key: "effort", label: "Effort", type: "text", default: "medium" },
      { key: "expectedRemoteControlUrl", label: "Expected RC session URL", type: "text" },
      { key: "channelBridgeRoot", label: "Claude channel bridge package directory (optional)", type: "text" },
      { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 900 },
    ],
  }),
};
