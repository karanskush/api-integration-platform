-- Executed Lineage: the record of chains actually run against a live API.
--
-- Everything the product says about call order has so far been derived. Both
-- get_call_sequence and trace_field stamp their own output "spec structure only
-- — no live traffic was observed to build this plan". These two tables hold the
-- evidence that lets that string be replaced with a receipt.
--
-- ZERO jsonb columns, on purpose, and strictly stronger than the discipline
-- operation_observations relies on: jsonb *could* hold a value and is kept safe
-- only by a careful writer, whereas an integer cannot hold one at all. A chain
-- reads a real identifier out of a customer's production account to make its
-- next call, so "there is nowhere to put it" has to be true of the schema, not
-- merely of the code.
--
-- The price is losing the full status histogram the canary keeps.
-- predominant_status and control_status are enough to debug a run with.
CREATE TABLE "lineage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"spec_version_id" uuid NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"status" text NOT NULL,
	"chains_planned" integer DEFAULT 0 NOT NULL,
	"chains_executed" integer DEFAULT 0 NOT NULL,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"budget_limit" integer DEFAULT 0 NOT NULL,
	-- Closed vocabularies, never a message: ssrf.ts throws `Invalid URL: <url>`
	-- and for an executed chain that URL carries the extracted identifier, so
	-- storing err.message the way analysis_runs does would compose into a leak.
	"aborted_reason" text,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
-- One row per edge per run, append-only and newest-wins on read — the shape
-- operation_observations already uses, and what makes lineageVerdict's
-- cross-run agreement rule computable. Refutation requires two runs to agree,
-- which is only expressible with history.
CREATE TABLE "lineage_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	-- NOT NULL: a claim about a contract that does not name the version it
	-- describes is worthless, and version fencing is established everywhere else.
	"spec_version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"producer_action_key" text NOT NULL,
	"producer_tool" text NOT NULL,
	"producer_field" text NOT NULL,
	"consumer_action_key" text NOT NULL,
	"consumer_tool" text NOT NULL,
	"consumer_field" text NOT NULL,
	"inferred_confidence" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"predominant_status" integer,
	-- The negative control. A 2xx alone is correlation, not verification: a
	-- soft-404 API answers 200 to a fabricated id too. These two columns are
	-- what make an `observed` verdict admissible at all.
	"control_attempted" boolean DEFAULT false NOT NULL,
	"control_status" integer,
	"latency_p50_ms" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lineage_runs" ADD CONSTRAINT "lineage_runs_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_runs" ADD CONSTRAINT "lineage_runs_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_executions" ADD CONSTRAINT "lineage_executions_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_executions" ADD CONSTRAINT "lineage_executions_spec_version_id_spec_versions_id_fk" FOREIGN KEY ("spec_version_id") REFERENCES "public"."spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_executions" ADD CONSTRAINT "lineage_executions_run_id_lineage_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lineage_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lineage_runs_api_id_started_at_idx" ON "lineage_runs" USING btree ("api_id","started_at");--> statement-breakpoint
CREATE INDEX "lineage_executions_edge_idx" ON "lineage_executions" USING btree ("api_id","spec_version_id","consumer_tool","consumer_field","observed_at");--> statement-breakpoint
CREATE INDEX "lineage_executions_run_id_idx" ON "lineage_executions" USING btree ("run_id");
