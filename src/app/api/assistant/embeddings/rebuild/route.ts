import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { UNSUPPORTED_PATTERN } from "@/lib/assistant";
import { embedModel, embedText, faqIndexText, upsertFaqEmbedding } from "@/lib/embeddings";

// Rebuild the pgvector FAQ index from the admin-curated Faq table.
// Only matchable FAQs are embedded (same TOR exclusion as the chat route).
// Safe to re-run any time: upserts by faqId. Slow on CPU (~1s/FAQ for the
// first call while Ollama loads the model), so this is admin-triggered,
// not per-request.
export async function POST() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const faqs = await prisma.faq.findMany({ orderBy: { createdAt: "asc" } });
  const matchable = faqs.filter((f) => !UNSUPPORTED_PATTERN.test(`${f.q} ${f.a}`));

  let embedded = 0;
  const failed: string[] = [];
  for (const faq of matchable) {
    const vec = await embedText(faqIndexText(faq));
    if (!vec) {
      failed.push(faq.id);
      continue;
    }
    try {
      await upsertFaqEmbedding(faq.id, vec);
      embedded += 1;
    } catch {
      failed.push(faq.id);
    }
  }
  if (failed.length && embedded === 0) {
    return jsonError(
      503,
      "Embedding backend is unavailable. Start Ollama and try again.",
      "EMBEDDING_UNAVAILABLE"
    );
  }

  await addAudit(
    "INFO",
    `FAQ embeddings rebuilt by ${auth.name}: ${embedded} embedded, ${failed.length} failed.`
  );
  return NextResponse.json({
    model: embedModel(),
    total: faqs.length,
    skipped: faqs.length - matchable.length,
    embedded,
    failed,
  });
}
