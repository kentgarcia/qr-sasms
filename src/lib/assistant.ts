import { prisma } from "./prisma";

// Phase 0 of docs/ai-assistant-ticket-escalation-spec.md.
//
// Server-side inquiry matching with a three-state confidence gate.
// v0 uses the same keyword scoring the client chatbot historically used
// (question x3, category x2, answer x1); Phase 1 replaces `matchFaqs`
// with pgvector cosine search over embeddings. The gate (`resolveInquiry`)
// and its reply contract stay the same across phases.

// Canonical safety fallback (spec §15). Single source of truth —
// the client renders whatever `reply` the server returns, so there is
// exactly one place where fallback wording can drift.
export const ASSISTANT_FALLBACK_MESSAGE =
  "I don't have enough information to answer that accurately.\n\n" +
  "You can create a support ticket and the appropriate office will be able to assist you.";

// Mirrors the guard in GET/POST /api/modules/faqs: Transcript of Records
// is not handled by this system, so TOR content must never be matched.
export const UNSUPPORTED_PATTERN = /\btor\b|transcript of records/i;

const STOP_WORDS = new Set([
  "about", "also", "and", "ang", "are", "ba", "can", "could", "does",
  "for", "from", "get", "how", "i", "is", "it", "ko", "mga", "need",
  "ng", "of", "on", "or", "please", "pwede", "sa", "the", "to",
  "what", "where", "when", "with", "you", "your",
]);

// Words so generic they must not carry a match on their own
// (e.g. "how do I request" matches every request FAQ).
const GENERIC_KEYWORDS = new Set(["request", "service", "student"]);

// Phase 3: deep-link allowlist (spec §4B/§11). The assistant may only link
// to these in-app pages — targets outside this list are never emitted,
// so answers can't point students at invented routes.
export type AssistantLink = { label: string; target: string };

const CATEGORY_LINKS: Array<{ match: RegExp; links: AssistantLink[] }> = [
  { match: /appoint/i, links: [{ label: "Open Appointments", target: "page-appointment" }] },
  { match: /\bid\b|identification/i, links: [{ label: "Open ID Application", target: "page-idapp" }] },
  { match: /event/i, links: [{ label: "Open Student Bulletin", target: "page-bulletin" }] },
  {
    // Document/request answers route to the current student funnel: filing
    // happens on the Book Appointment page, tracking in My Appointments.
    // (page-requests "Authentication, Excuse Slip & Visits" is legacy —
    // it is not in the student sidebar.)
    match: /document|request|authentication|excuse|visit|service/i,
    links: [{ label: "Open Appointments", target: "page-appointment" }],
  },
];

export function linksForCategory(cat: string): AssistantLink[] {
  const entry = CATEGORY_LINKS.find((e) => e.match.test(String(cat || "")));
  return entry ? entry.links : [];
}

export function linksForDataSource(dataSource: string | null): AssistantLink[] {
  if (!dataSource) return [];
  const first = dataSource.split(",")[0] || "";
  const kind = first.split(":")[0];
  if (kind === "ticket" || kind === "tickets")
    return [{ label: "Open Help Desk", target: "page-helpdesk" }];
  if (kind === "appointment") return [{ label: "Open Appointments", target: "page-appointment" }];
  if (kind === "idapp") return [{ label: "Open ID Application", target: "page-idapp" }];
  if (kind === "event") return [{ label: "Open Student Bulletin", target: "page-bulletin" }];
  if (kind === "request" || kind === "requests")
    return [{ label: "Open Appointments", target: "page-appointment" }];
  return [];
}

export type FaqRow = { id: string; cat: string; q: string; a: string };

export type AssistantConfidence = "high" | "medium" | "low";

export type TicketDraft = { category: string; subject: string; message: string };

export type InquiryResult = {
  reply: string;
  confidence: AssistantConfidence;
  faqId: string | null;
  faqQuestion: string | null;
  clarification: string | null;
  ticketDraft: TicketDraft | null;
};

function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function extractKeywords(value: string): string[] {
  const words = String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.map(stem).filter((w) => !STOP_WORDS.has(w)))];
}

export function scoreFaq(faq: FaqRow, keywords: string[]): number {
  const q = String(faq.q || "").toLowerCase();
  const a = String(faq.a || "").toLowerCase();
  const cat = String(faq.cat || "").toLowerCase();
  return keywords.reduce(
    (score, word) =>
      score + (q.includes(word) ? 3 : 0) + (cat.includes(word) ? 2 : 0) + (a.includes(word) ? 1 : 0),
    0
  );
}

export function minimumScoreFor(keywords: string[]): number {
  return keywords.length > 1 ? 2 : 3;
}

const DEFAULT_HIGH_SCORE = 6;

const DEFAULT_HIGH_SIMILARITY = 0.6;
const DEFAULT_MEDIUM_SIMILARITY = 0.45;

export async function getAssistantHighScore(): Promise<number> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: "assistant.highScore" } });
    const n = row ? Number(row.value) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  } catch {
    // Settings table unreachable — fall through to the default.
  }
  return DEFAULT_HIGH_SCORE;
}

export async function getAssistantSimilarities(): Promise<{ high: number; medium: number }> {
  const fallback = { high: DEFAULT_HIGH_SIMILARITY, medium: DEFAULT_MEDIUM_SIMILARITY };
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ["assistant.highSimilarity", "assistant.mediumSimilarity"] } },
    });
    const values = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    const high = values["assistant.highSimilarity"];
    const medium = values["assistant.mediumSimilarity"];
    return {
      high: high > 0 && high <= 1 ? high : fallback.high,
      medium: medium > 0 && medium <= 1 ? medium : fallback.medium,
    };
  } catch {
    return fallback;
  }
}

// Reference codes students paste into chat. Prefixes mirror the genId/
// APT-### schemes in the API routes (REF/CMP omitted — see assistant-data.ts).
export function extractRefs(text: string): string[] {
  const matches = String(text || "").toUpperCase().match(/\b(TKT|AUT|EXC|GEN|IDA|EVT|APT)-[A-Z0-9-]{3,}\b/g);
  return matches ? [...new Set(matches)] : [];
}

export function draftSubject(question: string): string {
  const q = question.trim().replace(/\s+/g, " ");
  return `Chatbot assistance: ${q.length > 70 ? `${q.slice(0, 67)}...` : q}`;
}

export type RankedSemanticFaq = { faq: FaqRow; similarity: number };

// Phase 1 semantic gate. Same reply contract as resolveInquiry (high →
// answer, medium → clarify, low → fallback + ticket draft) so the chat
// route and client work unchanged regardless of match mode.
export function resolveSemantic(
  question: string,
  ranked: RankedSemanticFaq[],
  high: number = DEFAULT_HIGH_SIMILARITY,
  medium: number = DEFAULT_MEDIUM_SIMILARITY
): InquiryResult {
  const best = ranked[0];
  const runnerUp = ranked[1];
  const noMatch = (category: string): InquiryResult => ({
    reply: ASSISTANT_FALLBACK_MESSAGE,
    confidence: "low",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    ticketDraft: {
      category,
      subject: draftSubject(question),
      message: question.trim(),
    },
  });
  if (!best) return noMatch("");

  if (best.similarity >= high) {
    return {
      reply: best.faq.a,
      confidence: "high",
      faqId: best.faq.id,
      faqQuestion: best.faq.q,
      clarification: null,
      ticketDraft: null,
    };
  }
  if (best.similarity >= medium) {
    const closeRunnerUp =
      runnerUp && best.similarity - runnerUp.similarity <= 0.05 ? runnerUp : null;
    const clarification = closeRunnerUp
      ? `Are you asking about "${best.faq.q}" or "${runnerUp.faq.q}"? Please pick one, rephrase your question, or I can create a support ticket for you.`
      : `Are you asking about "${best.faq.q}"? If yes, I can answer from that FAQ — otherwise please rephrase, or I can create a support ticket for you.`;
    return {
      reply: clarification,
      confidence: "medium",
      faqId: best.faq.id,
      faqQuestion: best.faq.q,
      clarification,
      ticketDraft: {
        category: best.faq.cat,
        subject: draftSubject(question),
        message: question.trim(),
      },
    };
  }
  return noMatch("");
}

export function resolveInquiry(
  question: string,
  faqs: FaqRow[],
  highScore: number = DEFAULT_HIGH_SCORE
): InquiryResult {
  const keywords = extractKeywords(question);
  const specific = keywords.filter((w) => !GENERIC_KEYWORDS.has(w));
  const minScore = minimumScoreFor(keywords);
  const ranked = faqs
    .map((faq) => ({
      faq,
      score: scoreFaq(faq, keywords),
      specificScore: scoreFaq(faq, specific),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];

  const noMatch: InquiryResult = {
    reply: ASSISTANT_FALLBACK_MESSAGE,
    confidence: "low",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    // No category guess on low confidence — a wrong pre-fill miscategorizes
    // the ticket; the student picks it (medium keeps the candidate's cat).
    ticketDraft: {
      category: "",
      subject: draftSubject(question),
      message: question.trim(),
    },
  };
  if (!best || keywords.length === 0 || best.score < minScore) return noMatch;

  const specificOk = specific.length > 0 && best.specificScore > 0;
  if (best.score >= highScore && specificOk) {
    return {
      reply: best.faq.a,
      confidence: "high",
      faqId: best.faq.id,
      faqQuestion: best.faq.q,
      clarification: null,
      ticketDraft: null,
    };
  }

  // Medium: a potentially relevant result, but not confident enough to answer.
  // Name the top candidate (plus runner-up when it scored close) and let the
  // student confirm, rephrase, or escalate.
  const closeRunnerUp =
    runnerUp && runnerUp.score >= minScore && best.score - runnerUp.score <= 2 ? runnerUp : null;
  const clarification = closeRunnerUp
    ? `Are you asking about "${best.faq.q}" or "${closeRunnerUp.faq.q}"? Please pick one, rephrase your question, or I can create a support ticket for you.`
    : `Are you asking about "${best.faq.q}"? If yes, I can answer from that FAQ — otherwise please rephrase, or I can create a support ticket for you.`;
  return {
    reply: clarification,
    confidence: "medium",
    faqId: best.faq.id,
    faqQuestion: best.faq.q,
    clarification,
    ticketDraft: {
      category: best.faq.cat,
      subject: draftSubject(question),
      message: question.trim(),
    },
  };
}
