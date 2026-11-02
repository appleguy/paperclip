# Agent Live Inspector (GLM + Qwen Quality)

Status: UI and two authenticated backend endpoints deployed into the pinned
Paperclip 965184d2 managed payload on October 30, 2026 Pacific. The targeted
compiled backend patch was applied to the managed runtime, with backup of the
original route file; `pc service restart --json` hot-restarted the service,
adopting GLM and Qwen's prior process identities with zero lost runs. Verified
HTTP 200 under an existing board CLI credential for both native reasoning
endpoints and the GLM engine telemetry endpoint. No paid inference launched.

This is a local deployment overlay, NOT an upstream Git commit or a fully
reinstalled managed payload. An installer update may replace its backend files;
reverify and reapply only after reviewing the exact new source version.

## Shared layers

- `AgentLiveInspector.tsx` consumes the existing authorized Paperclip
  heartbeat run list, get, and live log with the common OpenCode transcript
  adapter, as well as the bounded native-reasoning endpoint. Filters include
  reasoning, tool calls/results and message events, with formatted/raw views.
- `agent-live-inspector-model.ts` handles queue-versus-running labels and
  runner-agnostic filtering. Never equate the queued run's elapsed age with
  decoding, or whole-run output tokens / elapsed seconds with decode speed.
- `/heartbeat-runs/:runId/native-reasoning` derives the exact `ses_...`
  identifier only from an already-authorized Paperclip run log. It reads
  fixed local OpenCode SQLite profiles read-only, time-bounded to the actual
  authorized run, with bounded parts/text and existing run-output
  authorization/redaction. Both GLM and Qwen Quality
  profiles are included. This is stored model output, not an assertion that
  every internal thought is available.
- `/agents/:id/engine-telemetry` uses model-specific fixed-target providers,
  with host-managed ssh to WRX80 and no user-defined shell commands, URLs,
  inference calls, model loading or services. It exposes Colibri scheduler
  metrics and GPU2 sampling with measured timestamp. Aggregated request
  latencies are explicitly labeled as server-lifetime means; true
  prefill/decode tokens/sec are unavailable in this endpoint. Qwen's engine
  metrics are not registered; add an exact-model adapter to the server registry,
  never fork the React inspector. Every provider is optional/fail-soft.

## Verification and safe rollout

- `pnpm exec vitest run ...agent-live-inspector-model.test.ts ...agent-engine-telemetry.test.ts ...agent-native-reasoning.test.ts`
- `pnpm --filter @paperclipai/ui typecheck`, `pnpm --filter @paperclipai/server typecheck`
- Real read-only session probes found native reasoning parts for SCO-316's
  GLM OpenCode session and SCO-306's Qwen Quality session. The Colibri
  provider returned healthy engine/counter + GPU2 measurements.
- The static frontend may be rebuilt via `pnpm --filter @paperclipai/ui build`
  and reinstalled into the managed `@paperclipai/server/ui-dist` without
  restarting, preserving the pinned `paperclip-uuid-compat.js` shim.
- Backend route module and two local services are installed into the existing
  managed server/dist as a SHA-verified targeted overlay. The supported
  non-draining hot restart adopted both running processes, zero lost runs.
- API health still reports upstream 965184d2: it identifies the *base release*,
  not the local overlay. Verify the deployed backend module hashes in the
  dated ops receipt before any update/restart.
- Authenticated owner smoke: engine 200/available, GLM native reasoning
  200/15 parts, Qwen reasoning 200/2 parts. Unauthenticated callers received
  scoped resource-not-found responses, not raw reasoning.
- An upgrade must carry or consciously retire this overlay, rebuild, and
  verify permission/redaction and frontend semantics without duplicate sends.
- Static rollback backup:
  `/Volumes/NVM/Paperclip/ops/agent-live-inspector/2026-10-30/index-before-live-inspector.html`.
