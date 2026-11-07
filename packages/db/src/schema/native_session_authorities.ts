import { sql } from "drizzle-orm";
import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Physical conversation identity is independent of agent/task/run aliases.
// Rows and generation high-water marks must never be deleted on run cleanup.
export const nativeSessionAuthorities = pgTable("native_session_authorities", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  provider: text("provider").notNull(),
  hostId: text("host_id").notNull(),
  hostEpoch: text("host_epoch").notNull(),
  provisionalId: text("provisional_id").notNull(),
  providerSessionId: text("provider_session_id"),
  generation: bigint("generation", { mode: "bigint" }).notNull().default(sql`0`),
  state: text("state").notNull().default("free"),
  controllerId: text("controller_id"),
  agentId: uuid("agent_id").references(() => agents.id),
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  gatewayIncarnation: text("gateway_incarnation"),
  evidenceId: text("evidence_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  provisionalUnique: uniqueIndex("native_session_authorities_provisional_uniq").on(t.companyId, t.provider, t.hostId, t.provisionalId),
  providerUnique: uniqueIndex("native_session_authorities_provider_uniq").on(t.companyId, t.provider, t.hostId, t.providerSessionId),
  generationCheck: check("native_session_authorities_generation_check", sql`${t.generation} >= 0`),
  stateCheck: check("native_session_authorities_state_check", sql`${t.state} in ('free', 'installing', 'active', 'revoking', 'unknown')`),
  holderCheck: check("native_session_authorities_holder_check", sql`${t.state} = 'free' or (${t.controllerId} is not null and ${t.agentId} is not null and ${t.runId} is not null and ${t.gatewayIncarnation} is not null)`),
}));

export const nativeSessionAuthorityEvents = pgTable("native_session_authority_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  authorityId: uuid("authority_id").notNull().references(() => nativeSessionAuthorities.id),
  generation: bigint("generation", { mode: "bigint" }).notNull(),
  action: text("action").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  evidenceId: text("evidence_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
