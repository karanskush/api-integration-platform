-- The events an API emits, per spec version.
--
-- OpenAPI 3.1 `webhooks` and 3.0 operation `callbacks` were never parsed, so
-- the one part of a contract that describes traffic in the OTHER direction —
-- which events arrive, how, carrying what — reached neither the page nor an
-- agent. Nullable: a version that declares none stores none, and the column's
-- presence on a row means something.
ALTER TABLE "spec_versions" ADD COLUMN "webhooks" jsonb;
