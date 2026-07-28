-- Triage may downgrade a question to an assumption, never delete or answer one.
--
-- status gains 'assumed' with no ALTER TYPE, because schema.ts deliberately uses
-- text over pgEnum for exactly this. The existing
-- clarifications_answered_is_human CHECK already covers the new state correctly:
-- 'assumed' is not 'answered', so an assumption can carry answer_source = 'llm'
-- while remaining structurally unable to claim a human answered it.

-- The option value the model concluded, always one the question itself offered.
ALTER TABLE "clarifications" ADD COLUMN "assumed_answer" jsonb;--> statement-breakpoint

-- What it relied on: { quote, sourceKind, sourceUrl? }. Stored rather than
-- derived because the owner is shown the exact sentence and where it came from,
-- and "trust us" is not an acceptable substitute for that.
ALTER TABLE "clarifications" ADD COLUMN "assumed_basis" jsonb;--> statement-breakpoint

-- Assumptions are read as a set on the completion page and in finalize, and an
-- API with many of them should not scan the whole table for them.
CREATE INDEX "clarifications_spec_version_status_idx"
  ON "clarifications" USING btree ("spec_version_id","status");
