-- Clarifications become a quiz: clustered, archetyped, and answerable only by a human.
--
-- Every column is additive and either nullable or defaulted, so rows already in
-- the table stay valid and every existing insert path keeps working unchanged.

-- One question, N sites. `petId` appears on four Petstore operations; the
-- owner's single answer is true for all of them.
ALTER TABLE "clarifications" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "applies_to" jsonb;--> statement-breakpoint

-- The archetype drives the answer space the UI renders. Defaulted rather than
-- nullable so pre-existing rows have a renderable shape.
ALTER TABLE "clarifications" ADD COLUMN "archetype" text DEFAULT 'origin_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD COLUMN "answer_spec" jsonb;--> statement-breakpoint

-- Only ever 'human' today. The column and the CHECK exist now so that when an
-- LLM triage pass lands it is structurally unable to mark a question answered,
-- rather than merely not doing so. x-spotcheck-human-verified in the enriched
-- spec is derived from answered rows, so this constraint is what keeps that
-- claim honest at the database level.
ALTER TABLE "clarifications" ADD COLUMN "answer_source" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_answered_is_human"
  CHECK ("status" <> 'answered' OR "answer_source" = 'human');--> statement-breakpoint

-- Makes the collapse enforceable rather than merely intended: a retried enrich
-- job cannot re-insert a group that already exists for this spec version.
-- Partial, because group_key is null for anything not clustered.
CREATE UNIQUE INDEX "clarifications_spec_version_group_key_idx"
  ON "clarifications" USING btree ("spec_version_id","group_key")
  WHERE "group_key" IS NOT NULL;
