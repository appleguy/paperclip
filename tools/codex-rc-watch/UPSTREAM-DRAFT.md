# Draft: require connected Remote Control for app-server admission

Please consider an administrator-enforced app-server policy that requires Remote Control to be connected when a thread or turn is started. This is a draft, not an upstream submission.

Today `allow_remote_control` controls whether Remote Control is permitted; it does not require an active connection. Clients sharing the app-server socket can send `thread/start` or `turn/start` directly, bypassing client-side checks. A separate polling watcher cannot make admission atomic and cannot prevent a short unauthorized turn from running.

A server-side requirement in managed `requirements.toml` / MDM could reject `thread/start`, `thread/resume` and `turn/start` unless the server's own Remote Control controller is connected. The check and admission should be atomic with respect to connection state, apply to all transports and clients, and return a stable, actionable error. Administrators should be able to enforce it without allowing user configuration to weaken it. Please document behavior across reconnects, daemon updates, existing threads and active turns; a disconnect need not terminate an already-running turn unless explicitly configured.

References: [managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration/); [0.167 requirements model](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/config_requirements.rs); [Remote Control protocol](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/v2/remote_control.rs).
