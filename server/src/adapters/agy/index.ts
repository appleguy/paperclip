import type { ServerAdapterModule } from "../types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execute } from "./execute.js";
const run = promisify(execFile);

export const agyAdapter: ServerAdapterModule = {
  type: "agy_local",
  runtimeToolDelivery: "environment",
  execute,
  testEnvironment: async () => {
    const checks: Array<{ code: string; level: "info" | "error"; message: string }> = [];
    for (const [command, args, label] of [
      ["/opt/homebrew/bin/agy", ["--version"], "agy"],
      ["/opt/homebrew/bin/tmux", ["-V"], "tmux"],
    ] as const) {
      try {
        const output = await run(command, args, { timeout: 7000 });
        checks.push({ code: label, level: "info", message: `${label}: ${output.stdout.trim()}` });
      } catch {
        checks.push({ code: label, level: "error", message: `${label} missing or unavailable on Mac Pro` });
      }
    }
    return { adapterType: "agy_local", status: checks.some(c => c.level === "error") ? "fail" : "pass",
      testedAt: new Date().toISOString(), checks };
  },
  models: [
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low) via Antigravity RC" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium) via Antigravity RC" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High) via Antigravity RC" },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low) via Antigravity RC" },
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium) via Antigravity RC" },
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High) via Antigravity RC" },
    { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium) via Antigravity RC" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High) via Antigravity RC" },
    { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium) via Antigravity RC" },
    { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High) via Antigravity RC" },
  ],
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  // The provider lives in tmux; restart recovery re-enters only the exact
  // run checkpoint and never submits a replacement prompt.
  supportsRestartReattach: true,
  instructionsPathKey: "instructionsFilePath",
  agentConfigurationDoc: `# agy_local: one shared Antigravity Remote Control session

Requires macOS, agy 1.4.12 and tmux. Runs ONLY gemini-3.8-flash-{low,medium,high}, gemini-4-argon-{low,medium,high},
claude-opus-5-5-{medium,high} and claude-sonnet-5-5-{medium,high} (Claude draws the Antigravity 3p pool).
One persistent interactive TUI with a stable https://antigravity.google.com/r/... instance.
Paperclip turns are serialized. Each issue is isolated with /new, while the
owner sees/steers that same live process from the single RC instance.

Config:
- cwd: fixed, trusted work directory; all turns share it
- model: any model listed above, default gemini-3.8-flash-low (all other models refused); one
  TUI per tmuxSocket/tmuxSession, so give each model tier its own socket
- tmuxSocket (default paperclip-agy-rc); tmuxSession (default agy)
- stateDir (default ~/.paperclip/agy-rc-state): private lock, active checkpoint,
  per-agent status-line.json and one completion receipt per run; prune
  successful receipts after 7 days
- statusLine setup: merge statusline.settings.template.json as documented in
  statusline-install.md next to this adapter. The adapter never edits
  ~/.gemini/antigravity-cli/settings.json itself.
- input safety: statusLine agent_state must be idle AND the captured TUI input
  must be empty; a stale idle signal qualifies only after >=5 minutes.
  Every submission uses tmux bracketed paste (-p -r) and a named buffer.
- slots (1-4, default 1; Gemini models only, Claude stays 1): concurrent seats (SCO-991). Seat 1 is the
  configured session/stateDir/cwd; seat k>1 is tmux session <tmuxSession>-s<k-1> on the same socket, stateDir
  <stateDir>/s<k-1> and cwd /Volumes/NVM/AI_Agent_Runtime/workspaces/<tmuxSocket>-s<k-1> (trust it and add its
  statusLine pair). Set heartbeat.maxConcurrentRuns to the same N. Each seat has its own RC URL and lock.
- expectedRemoteControlUrl: optional stable /r/ instance URL guard (seat 1)
- timeoutSec (30-3600, default 600)

The agent writes a validated JSON completion receipt; the adapter, never the
model, uses its run-scoped token to PUT /documents/report then PATCH issue done.
Unresolved active.json blocks all new work, including after server restarts,
until an operator has inspected the original run and reconciled it. The
adapter never replays tool actions. Do not use headless agy -p as a proxy
for Remote Control; it does not share this live TUI.
`,
  getConfigSchema: () => ({
    fields: [
      { key: "cwd", label: "Shared trusted agy workspace", type: "text" },
      { key: "stateDir", label: "Private dispatch/receipt directory", type: "text" },
      { key: "tmuxSocket", label: "tmux server socket", type: "text", default: "paperclip-agy-rc" },
      { key: "tmuxSession", label: "tmux session", type: "text", default: "agy" },
      { key: "slots", label: "Concurrent seats (Gemini only, 1-4)", type: "number", default: 1 },
      { key: "expectedRemoteControlUrl", label: "Expected stable RC URL", type: "text" },
      { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 600 },
    ],
  }),
};
