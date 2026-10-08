import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { allowRequest } from "@/lib/rate-limit";
import {
  ASSISTANT_FALLBACK_MESSAGE,
  UNSUPPORTED_PATTERN,
  draftSubject,
  extractRefs,
  getAssistantHighScore,
  getAssistantSimilarities,
  linksForCategory,
  linksForDataSource,
  resolveInquiry,
  resolveSemantic,
  type AssistantLink,
  type InquiryResult,
} from "@/lib/assistant";
import { embedText, searchSimilar } from "@/lib/embeddings";
import {
  CAPABILITIES_REPLY,
  FAREWELL_REPLY,
  GREETING_REPLY,
  THANKS_REPLY,
  MAX_PILLS,
  STARTER_PILLS,
  TICKET_PILLS,
  matchStarterIntent,
  pillsForCategory,
  pillsForData,
  pillsForRuleLinks,
  type AssistantPill,
} from "@/lib/assistant-pills";
import {
  ACTIVE_APPOINTMENT,
  answerStatusQuestion,
  billingNotice,
  confidentialRedirect,
  hasBillingIntent,
  hasConfidentialRef,
  hasStatusIntent,
  type AssistantCard,
  type StatusAnswer,
  type StatusItem,
} from "@/lib/assistant-data";
import { analyzeMessage, hasTorIntent, stripGreetingPrefix, normalizeMessage } from "@/lib/assistant-words";
import { GUIDE_NUDGE, matchTxRule } from "@/lib/assistant-rules";
import {
  buildContext,
  clarificationQuestion,
  parseClarification,
  resolveWithContext,
  type ContextUsed,
} from "@/lib/assistant-context";

export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const rl = allowRequest(req, "assistant-chat", 30, 60_000);
  if (!rl.allowed) {
    return jsonError(429, "Too many questions. Please wait a moment and try again.", "RATE_LIMITED");
  }

  const body = await req.json().catch(() => ({}));
  const message = (body?.message || "").toString().trim();
  if (!message) return jsonError(400, "Message is required.", "EMPTY_MESSAGE");
  if (message.length > 2000) return jsonError(400, "Message is too long.", "MESSAGE_TOO_LONG");

  const requestedId = (body?.sessionId || "").toString();
  let session = null;
  if (requestedId) {
    session = await prisma.chatSession.findFirst({
      where: { id: requestedId, studentId: auth.studentId || "" },
    });
    if (!session) return jsonError(404, "Chat session not found.", "SESSION_NOT_FOUND");
  }

  // F-6 tap analytics: the tapped pill's label rides the next POST. Logged
  // as its own audit line (parse-safe; faq-analytics splits on ":" and only
  // reads index [1], which this prefix never disturbs).
  const viaPill = sanitizeViaPill(body?.viaPill);
  if (viaPill) {
    try {
      await prisma.auditLog.create({ data: { type: "INFO", msg: `CHATBOT_PILL_TAP:${viaPill}` } });
    } catch {
      // Telemetry must never break the answer.
    }
  }

  // Step-0 (improvement spec F-1): resolve follow-ups against this session's
  // own recent messages. The original text is persisted; the pipeline
  // evaluates the resolved form. Bound refs still pass every safety rail
  // and the sn-scoped SIS path unchanged below.
  const ctx = await buildContext(session?.id ?? null);
  const resolved = resolveWithContext(message, ctx);
  const eff = resolved.message;
  const contextUsed = resolved.contextUsed;

  // P-2: a clarification answer resolved to a verified FAQ — answer it
  // verbatim under the same contract as a high-confidence KB hit.
  if (resolved.clarificationFaqId) {
    const question = clarificationQuestion(ctx, resolved.clarificationFaqId);
    const faq = question ? await prisma.faq.findFirst({ where: { q: question } }) : null;
    if (faq && !UNSUPPORTED_PATTERN.test(`${faq.q} ${faq.a}`)) {
      const final: ChatResult = {
        reply: faq.a,
        confidence: "high",
        faqId: faq.id,
        faqQuestion: faq.q,
        clarification: null,
        ticketDraft: null,
        matchMode: "keyword",
        degraded: false,
        dataSource: null,
        items: [],
        intent: null,
        ruleId: null,
        contextUsed,
      };
      return respond(req, auth, session, message, final, null);
    }
    // Question text gone (FAQ deleted since) — fall through to the pipeline.
  }

  // P-3: ambiguous "the other one" — ask which instead of guessing.
  if (resolved.askWhich && resolved.askWhich.length) {
    const refs = resolved.askWhich.slice(0, 3);
    const line =
      `Which one do you mean — ${refs.join(" or ")}? ` +
      `Please tap a code or paste the reference and I'll look it up.`;
    const final: ChatResult = {
      reply: line,
      confidence: "medium",
      faqId: null,
      faqQuestion: null,
      clarification: line,
      ticketDraft: null,
      matchMode: "keyword",
      degraded: false,
      dataSource: null,
      items: [],
      intent: "clarify_ref",
      ruleId: null,
      contextUsed,
    };
    return respond(req, auth, session, message, final, null, {
      pills: refs.map((r) => ({ label: r, action: { type: "ask" as const, prompt: r } })),
    });
  }

  // Rule-based pipeline (docs/ai-assistant-rulebased-chatbot-spec.md §6.1):
  // safety → pasted-ref SIS → small-talk/rules (+ verified-FAQ precedence)
  // → FAQ → SIS digest → fallback. Rules never bypass safety rails.
  const stripped = stripGreetingPrefix(normalizeMessage(eff)).stripped;

  // SAFETY 1: TOR guard — never answer, never match (spec T-16).
  if (hasTorIntent(eff) || UNSUPPORTED_PATTERN.test(stripped)) {
    const final = torGuardReply(message);
    return respond(req, auth, session, message, final, null);
  }

  // SAFETY 2: confidential REF-/CMP- references — redirect, never DB-read (T-8·T-9).
  if (hasConfidentialRef(message)) {
    const status = confidentialRedirect(message);
    const final: ChatResult = {
      reply: status.reply,
      confidence: "high",
      faqId: null,
      faqQuestion: null,
      clarification: null,
      ticketDraft: status.ticketDraft,
      matchMode: "keyword",
      degraded: false,
      dataSource: null,
      items: [],
      intent: "confidential_redirect",
      ruleId: "confidential-redirect",
    };
    return respond(req, auth, session, message, final, null, {
      links: [{ label: "Open Help Desk", target: "page-helpdesk" }],
    });
  }

  // SAFETY 3: billing — explicit no-access notice (T-16).
  if (hasBillingIntent(message)) {
    const notice = billingNotice(message);
    const final: ChatResult = {
      reply: notice.reply,
      confidence: "low",
      faqId: null,
      faqQuestion: null,
      clarification: null,
      ticketDraft: notice.ticketDraft,
      matchMode: "keyword",
      degraded: false,
      dataSource: null,
      items: [],
      intent: "billing",
      ruleId: "billing-notice",
    };
    return respond(req, auth, session, message, final, null, {
      links: [{ label: "Open Help Desk", target: "page-helpdesk" }],
    });
  }

  // Pasted-ref fast path: an explicit record code always goes sn-scoped SIS
  // first — the KB can never answer it (spec §6.1).
  if (extractRefs(eff).length > 0) {
    const status = await answerStatusQuestion(eff, auth.studentId || "");
    if (status?.dataSource) {
      const final = toDataAnswer(baseResult(), status);
      return respond(req, auth, session, message, final, null);
    }
    if (status) {
      const final: ChatResult = {
        ...baseResult(),
        reply: status.reply,
        ticketDraft: status.ticketDraft,
        dataSource: null,
      };
      return respond(req, auth, session, message, final, null);
    }
  }

  // Small-talk & capability intents (T-17): warm voice, never a ticket draft.
  const starter = starterReply(eff, firstNameOf(auth.name));
  if (starter) {
    return respond(req, auth, session, message, starter, null);
  }

  // Same verified-answer source as the FAQ chatbot: admin-curated FAQs,
  // with the portal-wide TOR exclusion applied.
  const faqs = (await prisma.faq.findMany({ orderBy: { createdAt: "asc" } })).filter(
    (f) => !UNSUPPORTED_PATTERN.test(`${f.q} ${f.a}`)
  );

  // Transaction rules (T-1…T-15) fire before retrieval; a high-confidence
  // verified FAQ still wins verbatim on conflict (spec §3.2).
  const hit = matchTxRule(eff);
  const kbResult = await resolveWithBestMatch(effectiveMessage(eff, hit), faqs);
  if (kbResult.confidence === "high" && kbResult.faqId) {
    if (hit && hit.rule.id !== "guide-nudge") {
      // Verified text wins verbatim; links union the rule's buttons with the
      // FAQ category button (deduped), pills come from the rule.
      const final: ChatResult = {
        ...kbResult,
        intent: hit.rule.intent,
        ruleId: hit.rule.id,
      };
      const catLinks = faqs ? linksForCategory(faqs.find((f) => f.id === kbResult.faqId)?.cat || "") : [];
      const links = [...hit.rule.links];
      for (const l of catLinks) {
        if (!links.some((x) => x.target === l.target)) links.push(l);
      }
      return respond(req, auth, session, message, final, faqs, {
        links,
        pills: pillsForRuleLinks(hit.rule.links, null, hit.rule.ticketPill),
        followUp: toFollowUp(hit.rule.followAsk),
      });
    }
    return respond(req, auth, session, message, kbResult, faqs);
  }

  // Status inquiries with found records get the personalized readout before
  // generic guidance (e.g. "where is my excuse slip?" beats filing steps).
  // Guidance verbs (file/book/cancel/…) stay on the rule path; not-found
  // answers fall through to rules/FAQ so "how do I …" still guides.
  if (hasStatusIntent(eff) && !isGuidanceRequest(eff)) {
    const digest = await answerStatusQuestion(eff, auth.studentId || "");
    if (digest?.dataSource) {
      return respond(req, auth, session, message, toDataAnswer(baseResult(), digest), faqs);
    }
  }

  if (hit) {
    if (hit.rule.id === "guide-nudge") {
      const final: ChatResult = {
        reply: GUIDE_NUDGE,
        confidence: "high",
        faqId: null,
        faqQuestion: null,
        clarification: null,
        ticketDraft: null,
        matchMode: "keyword",
        degraded: false,
        dataSource: null,
        items: [],
        intent: "guide",
        ruleId: "guide-nudge",
      };
      return respond(req, auth, session, message, final, faqs, { links: [], pills: STARTER_PILLS.slice(0, MAX_PILLS) });
    }
    const final: ChatResult = {
      reply: hit.rule.reply,
      confidence: "high",
      faqId: null,
      faqQuestion: null,
      clarification: null,
      ticketDraft: null,
      matchMode: "keyword",
      degraded: false,
      dataSource: null,
      items: [],
      intent: hit.rule.intent,
      ruleId: hit.rule.id,
    };
    return respond(req, auth, session, message, final, faqs, {
      links: hit.rule.links,
      pills: pillsForRuleLinks(hit.rule.links, null, hit.rule.ticketPill),
      followUp: toFollowUp(hit.rule.followAsk),
    });
  }

  // No rule fired: KB medium/low → SIS digest → fallback, as in Phases 0–3.
  const result = await maybeAnswerFromSisData(eff, auth.studentId || "", kbResult);
  return respond(req, auth, session, message, result, faqs);
}

type SessionRow = { id: string } | null;

// Shared persist + respond helper so every pipeline branch logs and shapes
// identically. Audit uses `rule:<id>` for rule answers (analytics counts
// them as answered/high); FAQ answers keep the existing `FAQ:<id>` shape.
async function respond(
  _req: NextRequest,
  auth: { uid: string; studentId?: string | null },
  session: SessionRow,
  message: string,
  final: ChatResult,
  faqs: Array<{ id: string; cat: string }> | null,
  overrides?: { links?: AssistantLink[]; pills?: AssistantPill[]; followUp?: ChatResult["followUp"] }
) {
  const links = overrides?.links ?? linksForChatResult(final, faqs);
  const basePills = overrides?.pills ?? pillsForReply(final, faqs);
  const pills = await enhancePills(basePills, final, auth.studentId || null);
  const followUp = overrides?.followUp ?? final.followUp ?? null;

  if (!session) {
    session = await prisma.chatSession.create({
      data: {
        userId: auth.uid,
        studentId: auth.studentId || "",
        subject: message.slice(0, 80),
      },
    });
  }
  await prisma.chatMessage.createMany({
    data: [
      { sessionId: session.id, role: "student", text: message },
      {
        sessionId: session.id,
        role: "assistant",
        text: final.reply,
        faqId: final.faqId,
        confidence: final.confidence,
        dataSource: final.dataSource ?? null,
      },
    ],
  });
  await prisma.chatSession.update({
    where: { id: session.id },
    data: { updatedAt: new Date() },
  });
  // Keep the existing FAQ-usage analytics working: the client no longer
  // logs these directly; the server logs exactly one row per question.
  // The assistant message id rides along (`msg:<id>`) so F-2 feedback and
  // worst-rule analytics can join exactly. faq-analytics splits on ":" and
  // reads index [1], which this suffix never disturbs.
  const assistantMsg = await prisma.chatMessage.findFirst({
    where: { sessionId: session.id, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const feedbackId = assistantMsg?.id ?? null;
  await prisma.auditLog.create({
    data: {
      type: "INFO",
      msg: `FAQ_CHATBOT_QUERY:${final.ruleId ? `rule:${final.ruleId}` : (final.faqId ?? "unmatched")}${feedbackId ? ` msg:${feedbackId}` : ""}`,
    },
  });

  return NextResponse.json({
    sessionId: session.id,
    reply: final.reply,
    confidence: final.confidence,
    faqId: final.faqId,
    faqQuestion: final.faqQuestion,
    clarification: final.clarification,
    ticketDraft: final.ticketDraft,
    matchMode: final.matchMode,
    degraded: final.degraded,
    dataSource: final.dataSource,
    intent: final.intent,
    ruleId: final.ruleId,
    contextUsed: final.contextUsed ?? null,
    followUp,
    feedbackId,
    links,
    cards: cardsForItems(final.items),
    pills,
  });
}

// F-6 pill upgrades, applied to every branch (never more than MAX_PILLS,
// never a legacy target — builders below only emit allowlisted pages).
async function enhancePills(
  base: AssistantPill[],
  final: ChatResult,
  sn: string | null
): Promise<AssistantPill[]> {
  let out = [...base];
  // P-6b: clarification candidates as tappable pills (tap sends the exact
  // question text, which resolves verbatim — pairs with F-1 P-2).
  const clar = parseClarification(final.clarification);
  if (clar) {
    const ask = (q: string): AssistantPill => ({
      label: `About "${q.length > 34 ? `${q.slice(0, 31)}…”` : q}"`,
      action: { type: "ask", prompt: q },
    });
    const picks = clar.q2 ? [ask(clar.q1), ask(clar.q2)] : [ask(clar.q1)];
    out = [...picks, ...out.filter((p) => !picks.some((x) => x.label === p.label))];
  }
  // P-6a: appointment-intent answers get eligibility-aware pills.
  if (final.intent && APPOINTMENT_PILL_INTENTS.has(final.intent)) {
    out = await withVisitPills(out, sn, final.items);
  }
  // P-6a: pickup pill on data answers backed by pickup-ready records.
  if (final.dataSource && final.items.length && (await hasPickupReady(sn, final.items))) {
    const pill: AssistantPill = {
      label: "Track my pickup",
      action: { type: "ask", prompt: "When can I pick up my documents?" },
    };
    if (!out.some((p) => p.label === pill.label)) out = [...out, pill];
  }
  return out.slice(0, MAX_PILLS);
}

const APPOINTMENT_PILL_INTENTS = new Set(["book_appointment", "reschedule_appointment", "cancel_appointment"]);

async function withVisitPills(
  pills: AssistantPill[],
  sn: string | null,
  items: StatusItem[]
): Promise<AssistantPill[]> {
  let hasVisit = items.some((i) => i.kind === "appointment");
  if (!hasVisit && sn) {
    const row = await prisma.queueEntry.findFirst({
      where: { studentId: sn, status: { in: ACTIVE_APPOINTMENT } },
      select: { code: true },
    });
    hasVisit = !!row;
  }
  const ask = (label: string, prompt: string): AssistantPill => ({ label, action: { type: "ask", prompt } });
  if (hasVisit) {
    const lead = [
      ask("Reschedule my booking", "How do I reschedule my appointment?"),
      ask("Cancel my booking", "How do I cancel my appointment?"),
    ];
    return [...lead, ...pills.filter((p) => !lead.some((x) => x.label === p.label))].slice(0, MAX_PILLS);
  }
  const book: AssistantPill = { label: "Book an appointment", action: { type: "navigate", target: "page-appointment-book" } };
  const rest = pills.filter(
    (p) => !(p.action.type === "navigate" && p.action.target === "page-appointment-book")
  );
  return [book, ...rest].slice(0, MAX_PILLS);
}

async function hasPickupReady(sn: string | null, items: StatusItem[]): Promise<boolean> {
  if (!sn) return false;
  if (!items.some((i) => i.kind === "request" || i.kind === "idapp")) return false;
  const [svc, ida] = await Promise.all([
    prisma.serviceRequest.findFirst({
      where: { sn, status: { in: ["Ready for Pickup", "Pickup Scheduled"] } },
      select: { id: true },
    }),
    prisma.idApplication.findFirst({
      where: { sn, status: "Ready for Claiming" },
      select: { id: true },
    }),
  ]);
  return !!(svc || ida);
}

function torGuardReply(message: string): ChatResult {
  return {
    reply: ASSISTANT_FALLBACK_MESSAGE,
    confidence: "low",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    ticketDraft: {
      category: "",
      subject: draftSubject(message),
      message: message.trim(),
    },
    matchMode: "keyword",
    degraded: false,
    dataSource: null,
    items: [],
    intent: null,
    ruleId: "tor-guard",
  };
}

function starterReply(message: string, firstName: string): ChatResult | null {
  const intent = matchStarterIntent(message);
  if (!intent || intent === "guide") return null;
  const first = (firstName || "").trim();
  // F-5 personalization: first name + Manila daypart on the opener only.
  // No SN/course/record details; informational replies stay uniform.
  const daypart = manilaDaypart();
  const opener = daypart === "morning" ? "Good morning" : daypart === "afternoon" ? "Good afternoon" : "Good evening";
  const greeting = first
    ? GREETING_REPLY.replace(/^Hello! 👋/, `${opener}, ${first}! 👋`)
    : GREETING_REPLY;
  const capabilities = first
    ? CAPABILITIES_REPLY.replace(/^Here's what I can do:/, `Here's what I can do for you, ${first}:`)
    : CAPABILITIES_REPLY;
  const replies: Record<string, string> = {
    greeting,
    thanks: THANKS_REPLY,
    farewell: FAREWELL_REPLY,
    capabilities,
  };
  const reply = replies[intent];
  if (!reply) return null;
  return {
    reply,
    confidence: "high",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    ticketDraft: null,
    matchMode: "keyword",
    degraded: false,
    dataSource: null,
    items: [],
    intent,
    ruleId: `intent:${intent}`,
  };
}

// Guidance verbs keep a status-flavored question on the rule path
// ("how do I cancel my appointment?" guides; "where is my booking?" reads).
const GUIDANCE_VERBS = new Set(["file", "book", "guide", "capabilities", "cancel", "reschedule", "register", "create"]);

function sanitizeViaPill(value: unknown): string | null {
  const s = String(value || "")
    .replace(/[\r\n:]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return s ? s.slice(0, 60) : null;
}

function firstNameOf(name: string | null | undefined): string {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function manilaDaypart(): "morning" | "afternoon" | "evening" {
  try {
    const h =
      Number(
        new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", hour12: false }).format(new Date())
      ) % 24;
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 18) return "afternoon";
    return "evening";
  } catch {
    return "morning";
  }
}

function isGuidanceRequest(message: string): boolean {
  const tokens = analyzeMessage(message).tokenSet;
  for (const v of GUIDANCE_VERBS) if (tokens.has(v)) return true;
  return false;
}

// F-3: rule-authored next step, rendered as its own line + tappable pill
// (kept out of `pills` so it never duplicates there).
function toFollowUp(followAsk: { label: string; prompt: string } | null): ChatResult["followUp"] {
  if (!followAsk) return null;
  return {
    prompt: followAsk.prompt,
    pill: { label: followAsk.label, action: { type: "ask", prompt: followAsk.prompt } },
  };
}
// Guide phrases ("walk me through X") reach the same matcher as "how do I X".
function effectiveMessage(raw: string, hit: ReturnType<typeof matchTxRule>): string {
  if (hit && hit.rule.id !== "guide-nudge") return hit.analysis.stripped;
  return raw;
}

function baseResult(): ChatResult {
  return {
    reply: "",
    confidence: "low",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    ticketDraft: null,
    matchMode: "keyword",
    degraded: true,
    dataSource: null,
    items: [],
    intent: null,
    ruleId: null,
  };
}

function pillsForReply(
  result: ChatResult,
  faqs: Array<{ id: string; cat: string }> | null
): AssistantPill[] {
  if (result.ruleId?.startsWith("intent:") || result.ruleId === "guide-nudge") {
    return STARTER_PILLS.slice(0, MAX_PILLS);
  }
  // Confidential redirect carries a draft but stays high-confidence, so it
  // needs its ticket pills explicitly (the low-confidence branch below
  // doesn't apply).
  if (result.ruleId === "confidential-redirect") return TICKET_PILLS.slice(0, MAX_PILLS);
  // Escalation (low fallback, billing, not-found): prefilled create pill.
  if (result.ticketDraft && result.confidence === "low" && !result.faqId && !result.dataSource) {
    return [{ label: "Create a new ticket", action: { type: "ticket", prefill: result.ticketDraft } }];
  }
  if (result.dataSource) {
    const data = pillsForData(result.items);
    return (data.length ? data : TICKET_PILLS).slice(0, MAX_PILLS);
  }
  if (result.faqId && faqs) {
    const faq = faqs.find((f) => f.id === result.faqId);
    if (faq) return pillsForCategory(faq.cat);
  }
  return [];
}

function cardsForItems(items: StatusItem[]): AssistantCard[] {
  const all = (items || []).map((item) => ({
    kind: item.kind,
    ref: item.ref,
    title: item.title,
    status: item.status,
    meta: item.meta,
    link: linksForDataSource(item.dataSource)[0] || null,
  }));
  // Featured-narrowing (pills spec P-4): when tickets are present, ticket
  // cards collapse to the single most recent; other kinds stay.
  const ticketCards = all.filter((c) => c.kind === "ticket");
  if (!ticketCards.length) return all;
  return [...ticketCards.slice(0, 1), ...all.filter((c) => c.kind !== "ticket")];
}

function linksForChatResult(
  result: { faqId: string | null; dataSource: string | null; ruleId?: string | null; intent?: string | null },
  faqs: Array<{ id: string; cat: string }> | null
): AssistantLink[] {
  if (result.faqId && faqs) {
    const faq = faqs.find((f) => f.id === result.faqId);
    if (faq) return linksForCategory(faq.cat);
  }
  if (result.ruleId && !result.faqId && !result.dataSource) {
    // Rule-hit links are supplied via overrides; default to none so answers
    // can't point at invented routes.
    return [];
  }
  return linksForDataSource(result.dataSource);
}

type ChatResult = InquiryResult & {
  matchMode: "semantic" | "keyword";
  degraded: boolean;
  dataSource: string | null;
  items: StatusItem[];
  intent: string | null;
  ruleId: string | null;
  contextUsed?: ContextUsed | null;
  followUp?: { prompt: string; pill: AssistantPill } | null;
};

// F-3 follow-up for SIS-data answers: one journey-aware next step.
function followUpForItems(items: StatusItem[]): ChatResult["followUp"] {
  if (!items || !items.length) return null;
  if (items.some((i) => /needs revision/i.test(i.status || ""))) {
    const prompt = "How do I resubmit my request?";
    return { prompt, pill: { label: "How to resubmit", action: { type: "ask", prompt } } };
  }
  if (
    items.some(
      (i) =>
        i.kind === "appointment" &&
        ["BOOKED", "RESCHEDULED", "CHECKED_IN", "PENDING_APPROVAL", "PENDING"].includes(i.status)
    )
  ) {
    const prompt = "How do I reschedule my appointment?";
    return { prompt, pill: { label: "Reschedule my booking", action: { type: "ask", prompt } } };
  }
  return null;
}

// High-confidence KB answers stand. Anything else with status intent gets a
// shot at real student data; data answers report confidence high with
// faqId null and a dataSource for analytics.
async function maybeAnswerFromSisData(
  message: string,
  sn: string,
  kb: ChatResult
): Promise<ChatResult> {
  if (kb.confidence === "high") return kb;
  const status = await answerStatusQuestion(message, sn);
  if (!status) return kb;
  if (status.dataSource) return toDataAnswer(kb, status);
  return { ...kb, reply: status.reply, ticketDraft: status.ticketDraft, dataSource: null };
}

function toDataAnswer(kb: ChatResult, status: StatusAnswer): ChatResult {
  return {
    ...kb,
    reply: status.reply,
    confidence: "high",
    faqId: null,
    faqQuestion: null,
    clarification: null,
    ticketDraft: null,
    dataSource: status.dataSource,
    items: status.items,
    followUp: followUpForItems(status.items),
  };
}

// Semantic first (Phase 1), keyword fallback when the embedding backend is
// unavailable or the index is empty. The reply contract is identical either
// way — only matchMode/degraded differ.
async function resolveWithBestMatch(
  message: string,
  faqs: Array<{ id: string; cat: string; q: string; a: string }>
): Promise<ChatResult> {
  const byId = new Map(faqs.map((f) => [f.id, f]));
  const queryVec = await embedText(message);
  if (queryVec) {
    try {
      const ranked = (await searchSimilar(queryVec, 5))
        .filter((s) => byId.has(s.faqId))
        .map((s) => ({ faq: byId.get(s.faqId)!, similarity: s.similarity }));
      if (ranked.length) {
        const { high, medium } = await getAssistantSimilarities();
        return { ...resolveSemantic(message, ranked, high, medium), matchMode: "semantic", degraded: false, dataSource: null, items: [], intent: null, ruleId: null };
      }
    } catch {
      // pgvector query failed — fall through to keyword mode.
    }
  }
  return {
    ...resolveInquiry(message, faqs, await getAssistantHighScore()),
    matchMode: "keyword",
    degraded: true,
    dataSource: null,
    items: [],
    intent: null,
    ruleId: null,
  };
}
