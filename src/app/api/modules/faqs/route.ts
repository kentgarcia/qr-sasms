import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { UNSUPPORTED_PATTERN } from "@/lib/assistant";
import { genId } from "@/lib/format";


export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  await prisma.faq.upsert({
    where: { id: "FAQ-SEED7" },
    update: {},
    create: {
      id: "FAQ-SEED7",
      cat: "Document Requests",
      q: "How do I request an Excuse Slip?",
      a: "From your dashboard, select New Request or Excuse Slip under Quick Request. Choose Excuse Slip, select the purpose or reason, add notes if needed, then submit the request. You can track its status on your dashboard.",
    },
  });
  const rows = await prisma.faq.findMany({ orderBy: { createdAt: "asc" } });
  const unsupportedDocument = /\btor\b|transcript of records/i;
  return NextResponse.json(rows
    .map((faq) => faq.id === "FAQ-SEED1"
      ? { ...faq, a: "Most supported document requests are processed within 3–5 working days." }
      : faq)
    .filter((faq) => !unsupportedDocument.test(`${faq.q} ${faq.a}`)));
}
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const cat = (body?.cat || "").toString().trim() || "General";
  const q = (body?.q || "").toString().trim();
  const a = (body?.a || "").toString().trim();
  if (!q || !a) return jsonError(400, "Question and answer are required.", "MISSING_FIELDS");
  if (/\btor\b|transcript of records/i.test(`${q} ${a}`)) return jsonError(400, "Transcript of Records (TOR) is not handled by this system.", "UNSUPPORTED_SERVICE");

  const created = await prisma.faq.create({ data: { id: genId("FAQ"), cat, q, a } });
  await addAudit("INFO", `FAQ added by ${auth.name}.`);

  // Best-effort: keep the semantic index fresh. Never fails the request —
  // a down Ollama is covered by POST /api/assistant/embeddings/rebuild.
  try {
    if (!UNSUPPORTED_PATTERN.test(`${q} ${a}`)) {
      const { embedText, faqIndexText, upsertFaqEmbedding } = await import("@/lib/embeddings");
      const vec = await embedText(faqIndexText({ cat, q }));
      if (vec) await upsertFaqEmbedding(created.id, vec);
    }
  } catch {
    // Ignore — keyword fallback + rebuild cover this path.
  }

  return NextResponse.json(created, { status: 201 });
}
