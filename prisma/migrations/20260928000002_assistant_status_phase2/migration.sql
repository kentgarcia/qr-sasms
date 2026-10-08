-- Phase 2 (AI assistant + ticket escalation spec, docs/ai-assistant-ticket-escalation-spec.md).
-- Provenance for SIS-data answers so analytics can count them separately
-- from knowledge-base answers. Nullable; backfill not needed.

ALTER TABLE "ChatMessage" ADD COLUMN "dataSource" TEXT;
