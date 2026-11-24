import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import {
  ASSISTANT_FALLBACK_MESSAGE,
  UNSUPPORTED_PATTERN,
  getAssistantHighScore,
  getAssistantSimilarities,
  linksForCategory,
  resolveInquiry,
  resolveSemantic,
} from "@/lib/assistant";
import { embedText, searchSimilar } from "@/lib/embeddings";
import { matchStarterIntent } from "@/lib/assistant-pills";
import { hasBillingIntent, hasConfidentialRef } from "@/lib/assistant-data";
import { analyzeMessage, hasTorIntent, normalizeMessage, stripGreetingPrefix } from "@/lib/assistant-words";
import { matchTxRule } from "@/lib/assistant-rules";

/**
 * POST /api/assistant/simulate
 * Admin-only dry-run endpoint for the Chatbot Training Playground (spec S-5).
 * Runs the exact safety → starter → rule → FAQ/semantic pipeline without
 * creating ChatSession or ChatMessage rows.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const message = String(body?.message || "").trim();
  if (!message) return jsonError(400, "Enter a test message to simulate.", "EMPTY_MESSAGE");

  const analysis = analyzeMessage(message);
  const stripped = stripGreetingPrefix(normalizeMessage(message)).stripped;

  if (hasTorIntent(message) || UNSUPPORTED_PATTERN.test(stripped)) {
    return NextResponse.json({
      stage: "safety:tor_guard",
      confidence: "low",
      ruleId: null,
      faqId: null,
      tokens: analysis.tokens,
      reply: ASSISTANT_FALLBACK_MESSAGE,
      links: [],
    });
  }

  if (hasConfidentialRef(message)) {
    return NextResponse.json({
      stage: "safety:confidential_guard",
      confidence: "high",
      ruleId: null,
      faqId: null,
      tokens: analysis.tokens,
      reply: "Referral and Complaint details are confidential and cannot be read by the assistant.",
      links: [],
    });
  }

  if (hasBillingIntent(message)) {
    return NextResponse.json({
      stage: "safety:billing_guard",
      confidence: "high",
      ruleId: null,
      faqId: null,
      tokens: analysis.tokens,
      reply: "The assistant does not have access to tuition, fees, or billing records.",
      links: [],
    });
  }

  const starter = matchStarterIntent(message);
  if (starter && starter !== "guide") {
    return NextResponse.json({
      stage: `starter:${starter}`,
      confidence: "high",
      ruleId: null,
      faqId: null,
      tokens: analysis.tokens,
      reply: `Matched starter small-talk intent: ${starter}`,
      links: [],
    });
  }

  const ruleHit = matchTxRule(message);
  const [faqs, highScore, sims] = await Promise.all([
    prisma.faq.findMany({ select: { id: true, cat: true, q: true, a: true } }),
    getAssistantHighScore(),
    getAssistantSimilarities(),
  ]);

  let faqResult = resolveInquiry(message, faqs, highScore);
  let matchMode: "keyword" | "semantic" = "keyword";
  let semanticTopScore: number | null = null;

  try {
    const vec = await embedText(message);
    if (vec) {
      const hits = await searchSimilar(vec, 3);
      if (hits.length) {
        semanticTopScore = Number(hits[0].similarity.toFixed(3));
        const byId = new Map(faqs.map((f) => [f.id, f]));
        const ranked = hits
          .map((h) => {
            const faq = byId.get(h.faqId);
            return faq ? { faq, similarity: h.similarity } : null;
          })
          .filter((x): x is { faq: (typeof faqs)[number]; similarity: number } => x !== null);
        const sem = resolveSemantic(message, ranked, sims.high, sims.medium);
        if (sem.confidence === "high" || (sem.confidence === "medium" && faqResult.confidence === "low")) {
          faqResult = sem;
          matchMode = "semantic";
        }
      }
    }
  } catch {
    // Embeddings unavailable — keep keyword result.
  }

  if (faqResult.confidence === "high") {
    const matchedFaq = faqs.find((f) => f.id === faqResult.faqId);
    return NextResponse.json({
      stage: `faq:${matchMode}`,
      confidence: "high",
      ruleId: ruleHit?.rule.id || null,
      ruleScore: ruleHit?.score ?? null,
      faqId: faqResult.faqId,
      faqQuestion: faqResult.faqQuestion,
      semanticTopScore,
      tokens: analysis.tokens,
      reply: faqResult.reply,
      links: ruleHit ? ruleHit.rule.links : linksForCategory(matchedFaq?.cat || ""),
    });
  }

  if (ruleHit) {
    return NextResponse.json({
      stage: "rule",
      confidence: "high",
      ruleId: ruleHit.rule.id,
      ruleScore: ruleHit.score,
      faqId: faqResult.faqId,
      faqQuestion: faqResult.faqQuestion,
      semanticTopScore,
      tokens: analysis.tokens,
      reply: ruleHit.rule.reply,
      links: ruleHit.rule.links,
    });
  }

  return NextResponse.json({
    stage: faqResult.confidence === "medium" ? `faq:${matchMode}:clarify` : "fallback",
    confidence: faqResult.confidence,
    ruleId: null,
    ruleScore: null,
    faqId: faqResult.faqId,
    faqQuestion: faqResult.faqQuestion,
    semanticTopScore,
    tokens: analysis.tokens,
    reply: faqResult.reply,
    links: [],
  });
}
