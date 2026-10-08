-- Retire the IN_PROGRESS appointment step (2026-09-29): visits go straight
-- from CHECKED_IN to SERVED. Fold any in-flight rows back to CHECKED_IN so
-- capacity counts, guards and the UI (which no longer knows IN_PROGRESS)
-- keep treating them as active visits. Code-level normalizeStatus() keeps
-- the same mapping for any row this misses.

UPDATE "QueueEntry" SET "status" = 'CHECKED_IN' WHERE "status" = 'IN_PROGRESS';
