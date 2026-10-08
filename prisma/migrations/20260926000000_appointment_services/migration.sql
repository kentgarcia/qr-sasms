-- Appointment-based system: service lanes, lifecycle status, slot configs, slot blocks.
-- See docs/appointment-system-spec.md.
-- NOTE: the QueueEntry appointment columns (serviceType, serviceRefId,
-- organizationId, notes, status, dateISO, slotStartAt, slotEndAt) already
-- exist on databases that received the earlier out-of-tree migrations, so
-- every statement here is IF NOT EXISTS-guarded and the file is safe to
-- apply on fresh or drifted databases.

-- New columns (no-ops where they already exist)
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "serviceType" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "serviceRefId" TEXT;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "notes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'BOOKED';
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "dateISO" TEXT NOT NULL DEFAULT '';
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "slotStartAt" TIMESTAMP(3);
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "slotEndAt" TIMESTAMP(3);
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "bookedBy" TEXT;

-- Backfill legacy rows onto the canonical lifecycle:
--   served=true            -> SERVED
--   legacy PENDING (active) -> BOOKED
UPDATE "QueueEntry" SET "status" = 'SERVED' WHERE "served" = true AND "status" NOT IN ('SERVED', 'CANCELLED', 'NO_SHOW', 'CHECKED_IN');
UPDATE "QueueEntry" SET "status" = 'BOOKED' WHERE "served" = false AND "status" = 'PENDING';

-- ServiceSlotConfig (per-service capacity / duration / weekdays)
CREATE TABLE IF NOT EXISTS "ServiceSlotConfig" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 10,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "weekdays" INTEGER[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceSlotConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceSlotConfig_service_key" ON "ServiceSlotConfig"("service");

-- SlotBlock (admin-closed dates / slots)
CREATE TABLE IF NOT EXISTS "SlotBlock" (
    "id" TEXT NOT NULL,
    "dateLabel" TEXT NOT NULL,
    "time" TEXT,
    "service" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotBlock_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SlotBlock_dateLabel_idx" ON "SlotBlock"("dateLabel");

-- One active appointment per student per date (cancelled / no-show / served
-- history must not block rebooking): replace the legacy full unique
-- constraint with a partial unique index over active lifecycle rows.
ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_studentId_dateLabel_key";
CREATE UNIQUE INDEX IF NOT EXISTS "QueueEntry_student_active_idx"
  ON "QueueEntry"("studentId", "dateLabel")
  WHERE "status" IN ('BOOKED', 'RESCHEDULED', 'CHECKED_IN', 'PENDING');

-- Appointment lookup indexes
CREATE INDEX IF NOT EXISTS "QueueEntry_status_idx" ON "QueueEntry"("status");
CREATE INDEX IF NOT EXISTS "QueueEntry_serviceType_status_idx" ON "QueueEntry"("serviceType", "status");
CREATE INDEX IF NOT EXISTS "QueueEntry_dateLabel_time_serviceType_status_idx" ON "QueueEntry"("dateLabel", "time", "serviceType", "status");
