-- The credential audit trail outlives the API it describes
-- (GAP_ANALYSIS_2026-08-04.md §0.4).
--
-- credential_audit.api_id cascaded, so DELETE /api/apis/{slug} destroyed the
-- forensic record of every credential decrypt performed for that API. The audit
-- is what makes a vaulted credential defensible: every use attributable, and a
-- failed decrypt as interesting as a successful one. Both are most interesting
-- immediately after somebody has removed the thing they relate to, which is
-- exactly the moment the old cascade erased them.
--
-- api_id is already nullable, so SET NULL needs no data migration: existing rows
-- keep their api_id, and only a future deletion blanks it. org_id keeps its
-- cascade — when the ORG goes there is no tenant left with a right to the
-- record.
ALTER TABLE "credential_audit" DROP CONSTRAINT IF EXISTS "credential_audit_api_id_apis_id_fk";--> statement-breakpoint
ALTER TABLE "credential_audit" ADD CONSTRAINT "credential_audit_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE set null ON UPDATE no action;
