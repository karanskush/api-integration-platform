-- Sandbox credentials on every plan, and the environment a fact came from.
--
-- A dev/test key exists so a client can create, read, update and delete
-- without consequences. The vault already accepted `environment = 'sandbox'`
-- but nothing could resolve one, nothing recorded the owner's consent to use
-- it for writes, and every fact a probe produced was stamped 'production' as
-- a constant. These columns make environment a recorded property of the
-- credential and of the runs and scores that used it.
ALTER TABLE "credentials" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "write_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "write_consented_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "burst_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "burst_consented_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "inferred_environment" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "inference_basis" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "last_probe_run_at" timestamp with time zone;--> statement-breakpoint
-- Consent to mutate is meaningful only for a sandbox key. A production row can
-- never carry it, even through a bug — the database refuses the write.
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_write_consent_sandbox_only" CHECK ("write_consent_at" IS NULL OR "environment" = 'sandbox');--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_burst_consent_sandbox_only" CHECK ("burst_consent_at" IS NULL OR "environment" = 'sandbox');--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "environment" text NOT NULL DEFAULT 'production';--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "score_runs" ADD COLUMN "environment" text NOT NULL DEFAULT 'production';--> statement-breakpoint
ALTER TABLE "score_runs" ADD COLUMN "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "score_runs" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "score_runs" ADD COLUMN "base_url_basis" text;--> statement-breakpoint
ALTER TABLE "lineage_runs" ADD COLUMN "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL;
