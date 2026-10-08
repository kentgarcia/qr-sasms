-- One active appointment per student per date (cancelled / no-show / served
-- history must not block rebooking): replace the legacy full unique
-- constraint with a partial unique index over active lifecycle rows.

ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_studentId_dateLabel_key";
DROP INDEX IF EXISTS "public"."QueueEntry_studentId_dateLabel_key";
CREATE UNIQUE INDEX IF NOT EXISTS "QueueEntry_student_active_idx"
  ON "QueueEntry"("studentId", "dateLabel")
  WHERE "status" IN ('BOOKED', 'RESCHEDULED', 'CHECKED_IN', 'PENDING');
