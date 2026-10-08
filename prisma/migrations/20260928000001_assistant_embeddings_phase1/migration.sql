-- Phase 1 (AI assistant + ticket escalation spec, docs/ai-assistant-ticket-escalation-spec.md).
-- Semantic FAQ matching: pgvector store for all-MiniLM-L6-v2 (384-dim) embeddings.
-- The vector column is managed through raw SQL (Prisma Unsupported type);
-- rows are written by POST /api/assistant/embeddings/rebuild and the FAQ
-- create hook, and read by the chat route's cosine search. Keyword matching
-- in src/lib/assistant.ts remains the offline fallback.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "FaqEmbedding" (
    "faqId" TEXT NOT NULL,
    "embedding" vector(384),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaqEmbedding_pkey" PRIMARY KEY ("faqId")
);

ALTER TABLE "FaqEmbedding" ADD CONSTRAINT "FaqEmbedding_faqId_fkey" FOREIGN KEY ("faqId") REFERENCES "Faq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
