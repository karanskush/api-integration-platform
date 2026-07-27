CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"spec_version_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"spec_version_id" uuid NOT NULL,
	"action_id" uuid,
	"field_path" text,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "analysis_status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "arazzo_blob_ref" text;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "enriched_spec_blob_ref" text;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_api_id_started_at_idx" ON "analysis_runs" USING btree ("api_id","started_at");--> statement-breakpoint
CREATE INDEX "clarifications_api_id_status_idx" ON "clarifications" USING btree ("api_id","status");