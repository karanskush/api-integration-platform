CREATE TABLE "credential_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"credential_id" uuid,
	"org_id" uuid NOT NULL,
	"api_id" uuid,
	"environment" text,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_hash" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "iv" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "auth_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "wrapped_dek" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "hint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "mcp_token_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_audit" ADD CONSTRAINT "credential_audit_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_audit" ADD CONSTRAINT "credential_audit_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_audit" ADD CONSTRAINT "credential_audit_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_audit_org_id_created_at_idx" ON "credential_audit" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "credential_audit_credential_id_idx" ON "credential_audit" USING btree ("credential_id");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_api_environment_idx" ON "credentials" USING btree ("api_id","environment");--> statement-breakpoint
CREATE INDEX "credentials_org_id_idx" ON "credentials" USING btree ("org_id");