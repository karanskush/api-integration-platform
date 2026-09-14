-- Write probing: runs, the resource ledger, cleanup attempts, cleanup contracts.
--
-- A write probe creates fixtures with the owner's sandbox key and must be able
-- to prove it removed them. The ledger holds one row per created object, its
-- identifier sealed under the vault KEK only until deletion is confirmed
-- (then NULLed; the HMAC survives), and every cleanup attempt is a row — so a
-- run is never "succeeded" while cleanup is unresolved (§12.11) and a leaked
-- fixture is retried on the next run instead of forgotten.
CREATE TABLE "probe_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL REFERENCES "apis"("id") ON DELETE CASCADE,
	"spec_version_id" uuid NOT NULL REFERENCES "spec_versions"("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"families_planned" integer DEFAULT 0 NOT NULL,
	"families_executed" integer DEFAULT 0 NOT NULL,
	"requests_made" integer DEFAULT 0 NOT NULL,
	"budget_limit" integer DEFAULT 0 NOT NULL,
	"effects_used" integer DEFAULT 0 NOT NULL,
	"effect_budget" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"deleted_confirmed_count" integer DEFAULT 0 NOT NULL,
	"quarantined_count" integer DEFAULT 0 NOT NULL,
	"aborted_reason" text,
	"error_code" text,
	"credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
	"triggered_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "probe_runs_api_id_started_at_idx" ON "probe_runs" USING btree ("api_id","started_at");--> statement-breakpoint
CREATE TABLE "probe_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "probe_runs"("id") ON DELETE CASCADE,
	"api_id" uuid NOT NULL REFERENCES "apis"("id") ON DELETE CASCADE,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"entity" text NOT NULL,
	"create_action_key" text NOT NULL,
	"delete_action_key" text,
	"resource_id_hash" text NOT NULL,
	"resource_id_ciphertext" text,
	"resource_id_iv" text,
	"resource_id_auth_tag" text,
	"resource_id_wrapped_dek" text,
	"resource_id_key_version" integer,
	"id_source" text NOT NULL,
	"cleanup_status" text NOT NULL,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"accepted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_cleanup_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "probe_resources_api_env_status_idx" ON "probe_resources" USING btree ("api_id","environment","cleanup_status");--> statement-breakpoint
CREATE TABLE "probe_cleanup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL REFERENCES "probe_resources"("id") ON DELETE CASCADE,
	"run_id" uuid REFERENCES "probe_runs"("id") ON DELETE SET NULL,
	"delete_status" integer,
	"readback_status" integer,
	"result" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "cleanup_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL REFERENCES "apis"("id") ON DELETE CASCADE,
	"environment" text NOT NULL,
	"operation" text NOT NULL,
	"mechanism" text NOT NULL,
	"approved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"approved_at" timestamp with time zone,
	"tested_at" timestamp with time zone,
	"tested_run_id" uuid REFERENCES "probe_runs"("id") ON DELETE SET NULL,
	"residual_risk_accepted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "cleanup_contracts_api_env_operation_idx" ON "cleanup_contracts" USING btree ("api_id","environment","operation");
