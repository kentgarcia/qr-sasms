import { prisma } from "./prisma";

// Phase 1 of docs/ai-assistant-ticket-escalation-spec.md.
//
// Semantic FAQ matching: all-MiniLM-L6-v2 (384 dims) via a local Ollama
// instance, stored in pgvector. Every function here is outage-tolerant:
// Ollama down / unreachable / wrong dims → null / throw caught by callers,
// and the chat route falls back to keyword matching with degraded:true.
// No paid API, no data leaves the host.

export const EMBED_DIMS = 384;

export function embedModel(): string {
  return (process.env.ASSISTANT_EMBED_MODEL || "all-minilm:l6-v2").trim() || "all-minilm:l6-v2";
}

export function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
}

// Embed one text. Returns the 384-dim vector, or null when the embedding
// backend is unavailable (callers must fall back, never 500).
export async function embedText(text: string): Promise<number[] | null> {
  const input = String(text || "").trim();
  if (!input) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: embedModel(), input }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { embeddings?: number[][] } | null;
    const vec = data?.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length !== EMBED_DIMS || !vec.every(Number.isFinite)) return null;
    return vec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Canonical indexed text for an FAQ: category + question. The answer is
// deliberately excluded — long answers dilute question-question similarity.
export function faqIndexText(faq: { cat: string; q: string }): string {
  return `${faq.cat}\n${faq.q}`;
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export async function upsertFaqEmbedding(faqId: string, vec: number[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "FaqEmbedding" ("faqId", "embedding", "updatedAt") VALUES ($1, $2::vector, NOW())
     ON CONFLICT ("faqId") DO UPDATE SET "embedding" = EXCLUDED."embedding", "updatedAt" = NOW()`,
    faqId,
    vectorLiteral(vec)
  );
}

export type SimilarFaq = { faqId: string; similarity: number };

// Cosine similarity search. Returns up to `limit` rows ordered best-first.
// similarity is 1 - cosine distance, so 1 = identical, ~0 = unrelated.
export async function searchSimilar(vec: number[], limit = 5): Promise<SimilarFaq[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ faqId: string; similarity: number }>>(
    `SELECT "faqId", 1 - ("embedding" <=> $1::vector) AS similarity
     FROM "FaqEmbedding" WHERE "embedding" IS NOT NULL
     ORDER BY "embedding" <=> $1::vector LIMIT $2`,
    vectorLiteral(vec),
    limit
  );
  return rows.map((r) => ({ faqId: r.faqId, similarity: Number(r.similarity) }));
}
