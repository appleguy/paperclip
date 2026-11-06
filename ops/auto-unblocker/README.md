# Auto-unblocker

Source for the Board-operated blocked-issue sweep. The copy under
`/Volumes/NVM/Paperclip/ops/auto-unblocker` is the existing deployed tool;
this repository copy is not deployed automatically. Promote it only after the
server cancellation-reason change in the same commit is live.

The default is a dry run. Set `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`,
`PAPERCLIP_BOARD_API_KEY` and `PAPERCLIP_BOARD_AGENT_ID`; apply also requires
`PAPERCLIP_RUN_ID`. Do not print or store the credential in output. Run
`go run . --json` for inspection and `go run . --apply --json` for a live sweep.
Use `--older-than=1ns` for a one-time sweep of the current blocked set.

The tool rechecks each issue, dependency diagnostics, recovery action,
interactions and approvals before acting. It moves an ungated self-owned block
to todo, redelivers a peer-agent request with a transition-specific idempotency
key, and sends Board/user-owned blockers to a Board-addressed interaction.
Unresolved dependencies and pending gates are retained. Stale or agent-owned
auto-unblocker decisions are cancelled with an audit reason; genuine Board and
user decisions are retained. Cancellation itself wakes the origin agent.
Apply mode is serial and spaces actions at least twelve seconds apart. Missing
transition identity or an unconfirmed wake is reported as an exception.

Decision cleanup requires the server change which records `cancelReason`. The
tool stops if the server does not confirm it. The API exposes only the first
100 open decisions, so it refuses cleanup if that limit is reached. It never
creates standalone owner decisions. The report uses short issue identifiers.
