# Claude interactive Remote Control status

The experimental Claude interactive Runner requests a Remote Control name
containing the issue identifier, agent name and short run ID. It records a
`claude.remote_control.requested` run event with that name and the requested
local conversation UUID. The event is written before launch: it does not mean
the process started, connected, or appeared on a phone. The inspected Claude
interfaces do not expose an independently attributable Remote Control
connection state or identity; the event reports that state as unobservable.

Automatic default selection is not implemented. In particular, the current
interactive lane cannot safely be selected for every Claude wake: it lacks
durable owned-process recovery after server restart, can release launch
resources after an uncertain startup exit, and currently depends on explicit
host helper and state-directory configuration. The existing lane also requires a
local macOS PTY, a preconfigured subscription home, an explicit model and a
supported effort; remote targets, restart adoption, and other unsupported
adapter settings require their ordinary execution path. Selection and fallback
must preserve each configuration's behavior and must not claim Remote Control
visibility for fallback runs.

A live qualification must check the actual provider session on the phone,
including its requested name and steering in the same managed run, attributable
completion and accounting, process exit, subsequent wakes, concurrent agents,
and automatic cleanup after failed startup and server restart. A requested name,
local session UUID, hook or process record alone proves none of those outcomes.
