-- Living Twin v1 (SELF_MAINTAINING_APIS_2026-09-06.md §5, packages 1–4):
-- operation lifecycle on actions, conditional-GET poll state on spec_versions,
-- and the classified change ledger. Every column is additive and either
-- nullable or defaulted, so existing rows need no backfill.

-- OpenAPI `deprecated: true` and oasdiff's `x-sunset` (RFC 3339) on an
-- operation. Both were dropped by the normalizer until now, which made a
-- provider deprecating an endpoint invisible to the diff engine.
ALTER TABLE "actions" ADD COLUMN "deprecated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "sunset_at" timestamp with time zone;--> statement-breakpoint

-- Validators from the last fetch of source_url, so the hourly poller can send
-- If-None-Match / If-Modified-Since and treat a 304 as "checked, unchanged"
-- without transferring the spec (RFC 9110 §13). poll_status is
-- ok|not_modified|failed|unsupported; poll_error holds an error NAME or
-- http_NNN — never a message, which could echo provider text.
ALTER TABLE "spec_versions" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "last_modified" text;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "poll_status" text;--> statement-breakpoint
ALTER TABLE "spec_versions" ADD COLUMN "poll_error" text;--> statement-breakpoint

-- One row per classified change to an API's contract or observed lifecycle.
-- tool/method/path are denormalized on purpose: a REMOVED operation has no
-- row in the current version's actions, and the changelog must still name it.
-- action_id points at the new version's row for changed/added operations and
-- at the previous version's row for removed ones; API-level rows leave it NULL.
-- dedupe_key is set only by header-observed rows (source = 'header') so the
-- same Sunset date seen on every probe run collapses to one entry.
CREATE TABLE "api_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"from_spec_version_id" uuid,
	"to_spec_version_id" uuid,
	"action_id" uuid,
	"action_key" text,
	"tool" text,
	"method" text,
	"path" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"field_path" text,
	"location" text,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_changes" ADD CONSTRAINT "api_changes_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_changes" ADD CONSTRAINT "api_changes_from_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("from_spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_changes" ADD CONSTRAINT "api_changes_to_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("to_spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_changes" ADD CONSTRAINT "api_changes_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Ascending like evidence_facts_api_id_observed_at_idx: a btree scans backward
-- for ORDER BY observed_at DESC, so one index serves both directions.
CREATE INDEX "api_changes_api_id_observed_at_idx" ON "api_changes" USING btree ("api_id","observed_at");--> statement-breakpoint
CREATE INDEX "api_changes_api_id_severity_idx" ON "api_changes" USING btree ("api_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "api_changes_api_id_dedupe_key_idx"
  ON "api_changes" USING btree ("api_id","dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
