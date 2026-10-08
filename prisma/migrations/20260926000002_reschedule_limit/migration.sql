-- Reschedule limits: track how many times an appointment was rescheduled so
-- students cannot reschedule indefinitely (limit from SystemSetting
-- "maxReschedules", default 2).

ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "rescheduleCount" INTEGER NOT NULL DEFAULT 0;
