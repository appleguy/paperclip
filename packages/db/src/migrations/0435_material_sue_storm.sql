CREATE TABLE "native_session_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"host_id" text NOT NULL,
	"host_epoch" text NOT NULL,
	"provisional_id" text NOT NULL,
	"provider_session_id" text,
	"generation" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'free' NOT NULL,
	"controller_id" text,
	"agent_id" uuid,
	"run_id" uuid,
	"gateway_incarnation" text,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_session_authorities_generation_check" CHECK ("native_session_authorities"."generation" >= 0),
	CONSTRAINT "native_session_authorities_state_check" CHECK ("native_session_authorities"."state" in ('free', 'installing', 'active', 'revoking', 'unknown')),
	CONSTRAINT "native_session_authorities_holder_check" CHECK ("native_session_authorities"."state" = 'free' or ("native_session_authorities"."controller_id" is not null and "native_session_authorities"."agent_id" is not null and "native_session_authorities"."run_id" is not null and "native_session_authorities"."gateway_incarnation" is not null))
);
--> statement-breakpoint
CREATE TABLE "native_session_authority_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"action" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"evidence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authorities" ADD CONSTRAINT "native_session_authorities_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authority_events" ADD CONSTRAINT "native_session_authority_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authority_events" ADD CONSTRAINT "native_session_authority_events_authority_id_native_session_authorities_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."native_session_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authority_events" ADD CONSTRAINT "native_session_authority_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_authority_events" ADD CONSTRAINT "native_session_authority_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_session_authorities_provisional_uniq" ON "native_session_authorities" USING btree ("company_id","provider","host_id","provisional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_session_authorities_provider_uniq" ON "native_session_authorities" USING btree ("company_id","provider","host_id","provider_session_id");