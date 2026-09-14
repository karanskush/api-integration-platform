-- The sample size behind a verified score (GAP_ANALYSIS_2026-08-04.md §0.2).
--
-- A `scores` row could previously be written when not one upstream call had
-- succeeded. authClarity computes its subscore from the declared auth scheme
-- before any I/O and swallows a live failure; idempotency is a regex over
-- parameter names and makes no call at all. So an API that was unreachable,
-- rate-limited or returning nothing but 5xx still earned a row — and with
-- errorQuality and docDrift dropping out of the denominator for lack of data,
-- it could earn 100/100 with zero HTTP requests attempted.
--
-- These four columns are what make a row admissible rather than extra detail:
-- scoreWrite.ts refuses to write one unless live_calls_succeeded > 0, and
-- publishes how much of the total was actually observed against the running
-- API (observed_points) versus derived from the spec alone (static_points).
-- Splitting the blend rather than renaming it is what §0.2 asked for.
--
-- Defaults are 0 so existing rows migrate cleanly. They then read as "no
-- recorded sample", which is exactly true of a row written before this
-- accounting existed, and the read side reports it as such rather than
-- implying a measurement nobody took.
ALTER TABLE "scores" ADD COLUMN "live_calls_attempted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "live_calls_succeeded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "observed_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "static_points" integer DEFAULT 0 NOT NULL;
