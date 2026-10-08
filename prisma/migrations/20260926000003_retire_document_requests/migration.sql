-- Retire document requests: the flow is migrated into service-typed appointments
-- (Authentication / Excuse Slip lanes carry purpose + copies on the booking).
-- See docs/appointment-system-spec.md.

ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT '';
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "copies" INTEGER NOT NULL DEFAULT 1;

DROP TABLE IF EXISTS "DocumentRequest";
