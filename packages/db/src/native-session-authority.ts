import type { Sql, TransactionSql } from "postgres";

export type AuthorityActor = { companyId: string; agentId: string; runId: string };
export type AuthorityIdentity = {
  provider: string; hostId: string; hostEpoch: string; provisionalId: string;
};
export type AuthorityState = "free" | "installing" | "active" | "revoking" | "unknown";
export type WriterGrant = {
  authorityId: string; hostEpoch: string; generation: string;
  controllerId: string; gatewayIncarnation: string;
};
export type AuthoritySnapshot = AuthorityIdentity & {
  id: string; companyId: string; providerSessionId: string | null;
  generation: string; state: AuthorityState; controllerId: string | null;
  agentId: string | null; runId: string | null; gatewayIncarnation: string | null;
  evidenceId: string | null;
};

export class SessionAuthorityConflict extends Error {
  constructor(public readonly code: "actor" | "identity" | "grant" | "not_found") {
    super(`native_session_authority_${code}`);
  }
}

// Adapter/driver spellings must not create a second conversation namespace.
// Generic "acpx" is deliberately absent: callers must identify its provider.
const providerFamilies: Record<string, readonly string[]> = {
  codex: ["codex_local", "codex_app_server", "codex_acpx"],
  claude: ["claude_local", "claude_rc", "claude_code", "claude_native", "claude_acpx"],
  opencode: ["opencode_local", "opencode_server"],
  cursor: ["cursor_local", "cursor_cloud", "cursor_cloud_api", "cursor_acpx"],
  gemini: ["gemini_local", "gemini_acpx"],
  grok: ["grok_local", "grok_acpx"],
  kimi: ["kimi_local", "kimi_acpx"],
  pi: ["pi_local", "pi_acpx"], hermes: ["hermes_gateway"],
  openclaw: ["openclaw_gateway"], copilot: ["copilot_acpx"],
  antigravity: ["antigravity_headless", "antigravity_mcp"],
  openai_dot: ["openai_dot_mcp", "dot"], grok_bot: ["grok_bot_mcp"], muse: ["muse_external"],
  claude_managed: ["claude_managed_agents_api"], aws_agentcore: ["aws_agentcore_harness_api"],
};
export function canonicalNativeProvider(provider: string): string {
  nonempty(provider);
  for (const [family, aliases] of Object.entries(providerFamilies)) {
    if (provider === family || aliases.includes(provider)) return family;
  }
  // An extension must explicitly register a distinct physical provider namespace.
  if (/^plugin:[a-z0-9][a-z0-9._-]{0,127}$/.test(provider)) return provider;
  throw new SessionAuthorityConflict("identity");
}
function canonicalHost(hostId: string): string {
  // Use the durable host registry ID, never DNS, localhost, cwd, pane or seat.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hostId)) {
    throw new SessionAuthorityConflict("identity");
  }
  return hostId.toLowerCase();
}

type Tx = TransactionSql;
type Row = {
  id: string; company_id: string; provider: string; host_id: string; host_epoch: string;
  provisional_id: string; provider_session_id: string | null; generation: string;
  state: AuthorityState; controller_id: string | null; agent_id: string | null;
  run_id: string | null; gateway_incarnation: string | null; evidence_id: string | null;
};
function snapshot(r: Row): AuthoritySnapshot {
  return { id: r.id, companyId: r.company_id, provider: r.provider, hostId: r.host_id,
    hostEpoch: r.host_epoch, provisionalId: r.provisional_id, providerSessionId: r.provider_session_id,
    generation: String(r.generation), state: r.state, controllerId: r.controller_id,
    agentId: r.agent_id, runId: r.run_id, gatewayIncarnation: r.gateway_incarnation, evidenceId: r.evidence_id };
}
function nonempty(...values: string[]) {
  if (values.some((v) => typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > 1024)) {
    throw new SessionAuthorityConflict("identity");
  }
}
function generation(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new SessionAuthorityConflict("grant");
  }
}
async function authorize(tx: Tx, actor: AuthorityActor) {
  // The owning service supplies the authenticated actor; never accept this tuple
  // from an unauthenticated request. Membership/run binding is rechecked in SQL.
  const rows = await tx`SELECT r.id FROM heartbeat_runs r JOIN agents a ON a.id = r.agent_id
    WHERE r.id = ${actor.runId} AND r.company_id = ${actor.companyId}
      AND a.id = ${actor.agentId} AND a.company_id = ${actor.companyId}`;
  if (!rows.length) throw new SessionAuthorityConflict("actor");
}
async function audit(tx: Tx, actor: AuthorityActor, row: Row, action: string, evidenceId: string | null = null) {
  await tx`INSERT INTO native_session_authority_events
    (company_id, authority_id, generation, action, agent_id, run_id, evidence_id)
    VALUES (${actor.companyId}, ${row.id}, ${row.generation}, ${action}, ${actor.agentId}, ${actor.runId}, ${evidenceId})`;
}
async function locked(tx: Tx, actor: AuthorityActor, id: string) {
  const rows = await tx<Row[]>`SELECT * FROM native_session_authorities
    WHERE company_id = ${actor.companyId} AND id = ${id} FOR UPDATE`;
  if (!rows[0]) throw new SessionAuthorityConflict("not_found");
  return rows[0];
}
function matches(row: Row, actor: AuthorityActor, grant: WriterGrant) {
  generation(grant.generation);
  if (row.host_epoch !== grant.hostEpoch || String(row.generation) !== grant.generation ||
      row.controller_id !== grant.controllerId || row.gateway_incarnation !== grant.gatewayIncarnation ||
      row.agent_id !== actor.agentId || row.run_id !== actor.runId) throw new SessionAuthorityConflict("grant");
}

/** Durable control-plane grants, NOT a provider fence. No provider I/O occurs in
 * these short transactions. Only the serialized gateway may supply ACK/release
 * evidence after it has established exclusive ownership and settled prior work.
 * There is deliberately no timer-based expiry, force-free, row deletion or replay.
 */
export function createNativeSessionAuthorityStore(sql: Sql) {
  async function transition(actor: AuthorityActor, grant: WriterGrant,
    action: "activate" | "unknown" | "release", evidenceId: string) {
    nonempty(evidenceId);
    return sql.begin(async (tx) => {
      await authorize(tx, actor);
      const row = await locked(tx, actor, grant.authorityId);
      matches(row, actor, grant);
      const target = action === "activate" ? "active" : action === "release" ? "free" : "unknown";
      // Same exact durable acknowledgement is idempotent, including after lost ACK.
      if (row.state === target && row.evidence_id === evidenceId) return snapshot(row);
      if (action === "activate" && row.state !== "installing") throw new SessionAuthorityConflict("grant");
      if (action === "release" && row.state === "free") throw new SessionAuthorityConflict("grant");
      if (action === "unknown" && row.state === "free") throw new SessionAuthorityConflict("grant");
      const [updated] = await tx<Row[]>`UPDATE native_session_authorities
        SET state = ${target}, evidence_id = ${evidenceId}, updated_at = now()
        WHERE company_id = ${actor.companyId} AND id = ${row.id} RETURNING *`;
      await audit(tx, actor, updated!, action, evidenceId);
      return snapshot(updated!);
    });
  }
  return {
    async provision(actor: AuthorityActor, identity: AuthorityIdentity) {
      nonempty(identity.provider, identity.hostId, identity.hostEpoch, identity.provisionalId);
      identity = { ...identity, provider: canonicalNativeProvider(identity.provider), hostId: canonicalHost(identity.hostId) };
      return sql.begin(async (tx) => {
        await authorize(tx, actor);
        const inserted = await tx<Row[]>`INSERT INTO native_session_authorities
          (company_id, provider, host_id, host_epoch, provisional_id)
          VALUES (${actor.companyId}, ${identity.provider}, ${identity.hostId}, ${identity.hostEpoch}, ${identity.provisionalId})
          ON CONFLICT (company_id, provider, host_id, provisional_id) DO NOTHING RETURNING *`;
        const rows = inserted.length ? inserted : await tx<Row[]>`SELECT * FROM native_session_authorities
          WHERE company_id = ${actor.companyId} AND provider = ${identity.provider}
            AND host_id = ${identity.hostId} AND provisional_id = ${identity.provisionalId}`;
        const row = rows[0]!;
        if (row.host_epoch !== identity.hostEpoch) throw new SessionAuthorityConflict("identity");
        if (inserted.length) await audit(tx, actor, row, "provision");
        return snapshot(row);
      });
    },
    async read(actor: AuthorityActor, id: string) {
      return sql.begin(async (tx) => {
        await authorize(tx, actor);
        const rows = await tx<Row[]>`SELECT * FROM native_session_authorities
          WHERE company_id = ${actor.companyId} AND id = ${id}`;
        if (!rows[0]) throw new SessionAuthorityConflict("not_found");
        return snapshot(rows[0]);
      });
    },
    async findProvider(actor: AuthorityActor, provider: string, hostId: string, providerSessionId: string) {
      nonempty(provider, hostId, providerSessionId);
      provider = canonicalNativeProvider(provider);
      hostId = canonicalHost(hostId);
      return sql.begin(async (tx) => {
        await authorize(tx, actor);
        const rows = await tx<Row[]>`SELECT * FROM native_session_authorities
          WHERE company_id = ${actor.companyId} AND provider = ${provider}
            AND host_id = ${hostId} AND provider_session_id = ${providerSessionId}`;
        return rows[0] ? snapshot(rows[0]) : null;
      });
    },
    async reserve(actor: AuthorityActor, input: WriterGrant) {
      nonempty(input.controllerId, input.gatewayIncarnation, input.hostEpoch);
      generation(input.generation);
      return sql.begin(async (tx) => {
        await authorize(tx, actor);
        // Conditional UPDATE is the cross-client CAS. Active takeover only reserves
        // installing; it confers no right to emit before a gateway barrier ACK.
        const rows = await tx<Row[]>`UPDATE native_session_authorities
          SET generation = generation + 1, state = 'installing', controller_id = ${input.controllerId},
            agent_id = ${actor.agentId}, run_id = ${actor.runId}, gateway_incarnation = ${input.gatewayIncarnation},
            evidence_id = NULL, updated_at = now()
          WHERE company_id = ${actor.companyId} AND id = ${input.authorityId}
            AND host_epoch = ${input.hostEpoch} AND generation = ${input.generation}::bigint
            AND state IN ('free', 'active') RETURNING *`;
        if (!rows[0]) throw new SessionAuthorityConflict("grant");
        await audit(tx, actor, rows[0], "reserve");
        return snapshot(rows[0]);
      });
    },
    async bindProvider(actor: AuthorityActor, grant: WriterGrant, providerSessionId: string, evidenceId: string) {
      nonempty(providerSessionId, evidenceId);
      try {
        return await sql.begin(async (tx) => {
          await authorize(tx, actor);
          const row = await locked(tx, actor, grant.authorityId);
          matches(row, actor, grant);
          if (row.state === "free" || row.state === "unknown") throw new SessionAuthorityConflict("grant");
          if (row.provider_session_id === providerSessionId) return snapshot(row);
          if (row.provider_session_id !== null) throw new SessionAuthorityConflict("identity");
          // The unique physical identity index arbitrates concurrent alias binds.
          // Never merge two records or reset either grant/high-water mark.
          const [updated] = await tx<Row[]>`UPDATE native_session_authorities
            SET provider_session_id = ${providerSessionId}, updated_at = now()
            WHERE company_id = ${actor.companyId} AND id = ${row.id} RETURNING *`;
          await audit(tx, actor, updated!, "bind_provider", evidenceId);
          return snapshot(updated!);
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new SessionAuthorityConflict("identity");
        throw error;
      }
    },
    acknowledge: (actor: AuthorityActor, grant: WriterGrant, evidenceId: string) => transition(actor, grant, "activate", evidenceId),
    markUnknown: (actor: AuthorityActor, grant: WriterGrant, evidenceId: string) => transition(actor, grant, "unknown", evidenceId),
    // A gateway reconciliation receipt is mandatory even for installing/unknown.
    // A controller timeout or server restart must never call this on its own.
    release: (actor: AuthorityActor, grant: WriterGrant, evidenceId: string) => transition(actor, grant, "release", evidenceId),
    // Restart reconciliation belongs to the exclusive gateway, not a controller
    // claiming the old run's identity. Its authenticated current actor is audited.
    // The receipt must prove the prior effect settled and transport exclusion;
    // elapsed time/process absence is never such evidence.
    async reconcileSettled(actor: AuthorityActor, prior: WriterGrant, evidenceId: string) {
      nonempty(evidenceId);
      generation(prior.generation);
      return sql.begin(async (tx) => {
        await authorize(tx, actor);
        const row = await locked(tx, actor, prior.authorityId);
        if (row.host_epoch !== prior.hostEpoch || String(row.generation) !== prior.generation ||
            row.controller_id !== prior.controllerId || row.gateway_incarnation !== prior.gatewayIncarnation ||
            !["installing", "revoking", "unknown"].includes(row.state)) throw new SessionAuthorityConflict("grant");
        const [updated] = await tx<Row[]>`UPDATE native_session_authorities
          SET state = 'free', evidence_id = ${evidenceId}, updated_at = now()
          WHERE company_id = ${actor.companyId} AND id = ${row.id} RETURNING *`;
        await audit(tx, actor, updated!, "reconcile_settled", evidenceId);
        return snapshot(updated!);
      });
    },
  };
}
