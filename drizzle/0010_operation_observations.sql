-- The behavioral canary (SELF_MAINTAINING_APIS_2026-09-06.md §5 package 5).
--
-- Every change source shipped so far compares one DOCUMENT to another: a spec
-- against the previous spec, or a response against the spec. None of them can
-- see the case the product was named for — the API's behaviour moving while
-- its documentation stays perfectly still. That needs a record of what an
-- operation actually returned last time, to compare against what it returns
-- now.
--
-- What a snapshot stores is deliberately narrow: field PATHS, the JSON type
-- seen at each, and in how many samples it appeared. Never a value. A response
-- body is the single most likely place for a customer's PII or a live token to
-- appear, so the shape is inferred and the body is discarded — there is no
-- column here that could hold one.
CREATE TABLE "operation_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"action_id" uuid,
	"action_key" text NOT NULL,
	"spec_version_id" uuid,
	"environment" text DEFAULT 'production' NOT NULL,
	-- {"200": 3} — only successful samples build a shape; a run that saw no 2xx
	-- records no snapshot at all rather than one describing an outage.
	"status_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	-- { "response.data[].id": { "types": ["string"], "presentIn": 3 } }
	"shape" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_p50_ms" integer,
	"latency_max_ms" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operation_observations" ADD CONSTRAINT "operation_observations_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_observations" ADD CONSTRAINT "operation_observations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_observations" ADD CONSTRAINT "operation_observations_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The canary's only read: "the previous snapshot for this operation".
CREATE INDEX "operation_observations_api_action_observed_idx" ON "operation_observations" USING btree ("api_id","action_key","observed_at");
