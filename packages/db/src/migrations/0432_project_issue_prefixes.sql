ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "issue_prefix" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "issue_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_company_issue_prefix_uq" ON "projects" USING btree ("company_id","issue_prefix") WHERE "projects"."issue_prefix" is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_identifier_aliases" (
	"identifier" text PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_identifier_aliases" ADD CONSTRAINT "issue_identifier_aliases_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_identifier_aliases" ADD CONSTRAINT "issue_identifier_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_identifier_aliases_issue_idx" ON "issue_identifier_aliases" USING btree ("issue_id");
