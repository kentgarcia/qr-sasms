// Conversation memory for the assistant (improvement spec F-1).
//
// Short-term context derived per request from the session's own persisted
// messages — never stored separately, never crossing students. Resolves
// follow-ups (pronouns, ellipsis, clarification answers, "the other one")
// before the normal pipeline runs. Empty/expired context = today's behavior.

import { prisma } from "./prisma";
import { extractRefs } from "./assistant";
import { analyzeMessage, extractConfidentialRefs, matchStarterIntent } from "./assistant-words";
import { matchTxRule } from "./assistant-rules";

export type ChatContext = {
  /** Most-recent-first refs from this session (student mentions + answers). */
  lastRefs: string[];
  /** Re-resolved intent of the last student message (pure, no extra reads). */
  lastIntent: string | null;
  lastFaqId: string | null;
  pendingClarification: { faqQ1: string; faqQ2?: string | null } | null;
};

export type ContextUsed = { boundRef?: string; resolvedClarification?: string };

export type ContextResolution = {
  /** Message the pipeline should evaluate (pronoun-bound when applicable). */
  message: string;
  contextUsed: ContextUsed | null;
  /** Set when a clarification answer resolved to a verified FAQ id. */
  clarificationFaqId?: string | null;
  /** Set for P-3 "the other one" with != 2 refs: route asks which (no guess). */
  askWhich?: string[] | null;
};

const EMPTY: ChatContext = {
  lastRefs: [],
  lastIntent: null,
  lastFaqId: null,
  pendingClarification: null,
};

const CLARIFY_DOUBLE_RE = /Are you asking about "([^"]+)" or "([^"]+)"\?/;
const CLARIFY_SINGLE_RE = /Are you asking about "([^"]+)"\?/;

/** Parse a medium-confidence clarification reply back into candidates. */
export function parseClarification(text: string | null): { q1: string; q2?: string | null } | null {
  if (!text) return null;
  const double = CLARIFY_DOUBLE_RE.exec(text);
  if (double) return { q1: double[1], q2: double[2] };
  const single = CLARIFY_SINGLE_RE.exec(text);
  if (single) return { q1: single[1] };
  return null;
}

type MsgRow = { role: string; text: string; faqId: string | null; dataSource: string | null };

function refsFromDataSource(dataSource: string | null): string[] {
  if (!dataSource) return [];
  const out: string[] = [];
  for (const part of dataSource.split(",")) {
    const id = (part.split(":").slice(1).join(":") || "").trim();
    if (/^(TKT|AUT|EXC|GEN|IDA|EVT|APT)-[A-Z0-9-]{3,}$/.test(id)) out.push(id);
  }
  return out;
}

/** Build context from the caller's own session only (sn-scoped by route). */
export async function buildContext(sessionId: string | null): Promise<ChatContext> {
  if (!sessionId) return { ...EMPTY };
  let rows: MsgRow[];
  try {
    rows = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { role: true, text: true, faqId: true, dataSource: true },
    });
  } catch {
    return { ...EMPTY };
  }
  if (!rows.length) return { ...EMPTY };
  const chronological = [...rows].reverse();

  const lastRefs: string[] = [];
  const pushRef = (r: string) => {
    if (!lastRefs.includes(r)) lastRefs.push(r);
  };
  // Most-recent-first so lastRefs[0] is the freshest reference.
  for (const m of rows) {
    if (m.role === "student") {
      const conf = new Set(extractConfidentialRefs(m.text));
      for (const r of extractRefs(m.text)) {
        if (!conf.has(r)) pushRef(r);
      }
    } else if (m.role === "assistant") {
      for (const r of refsFromDataSource(m.dataSource)) pushRef(r);
    }
    if (lastRefs.length >= 3) break;
  }

  const lastAssistant = chronological.filter((m) => m.role === "assistant").at(-1) || null;
  const lastStudent = chronological.filter((m) => m.role === "student").at(-1) || null;
  const lastOverall = chronological.at(-1) || null;

  // Pending clarification only when the latest message overall is the
  // assistant's clarification question (single-slot, spec edge 3).
  let pendingClarification: ChatContext["pendingClarification"] = null;
  if (lastOverall && lastOverall.role === "assistant") {
    const double = CLARIFY_DOUBLE_RE.exec(lastOverall.text);
    if (double) {
      pendingClarification = { faqQ1: double[1], faqQ2: double[2] };
    } else {
      const single = CLARIFY_SINGLE_RE.exec(lastOverall.text);
      if (single) pendingClarification = { faqQ1: single[1] };
    }
  }

  return {
    lastRefs: lastRefs.slice(0, 3),
    lastIntent: intentOf(lastStudent?.text || null),
    lastFaqId: lastAssistant?.faqId || null,
    pendingClarification,
  };
}

/** Re-resolved intent of a past student message (pure, no extra reads). */
function intentOf(text: string | null): string | null {
  if (!text || !text.trim()) return null;
  const starter = matchStarterIntent(text);
  if (starter) return starter;
  return matchTxRule(text)?.rule.intent || null;
}

const FIRST_RE = /^(the\s+)?(first|1st|1|una|unang|yung una)(\s+one)?\.?$/i;
const SECOND_RE = /^(the\s+)?(second|2nd|2|pangalawa|ikalawa|yung pangalawa)(\s+one)?\.?$/i;
const YES_RE = /^(yes|yeah|yup|oo|opo|yes po|opo,? ?thanks?)\.?$/i;
const PRONOUN_RE = /\b(it|that|this|that one|ito|iyan|iyon|nito|niyan)\b/i;
const OTHER_ONE_RE = /\b(what about |how about )?the other( one)?\b|\byung (isa|ibang)( pa)?\b/i;

function stripEdgeNoise(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/^[?!"'.,]+|[?!"'.,]+$/g, "").trim();
}

/**
 * Step-0 of the pipeline. Returns the message to evaluate plus what fired.
 * Explicit refs always win (spec edge 1); pronouns bind only on short
 * messages with context (spec edge 2); unparseable input falls through.
 */
export function resolveWithContext(raw: string, ctx: ChatContext): ContextResolution {
  const none: ContextResolution = { message: raw, contextUsed: null };
  const norm = stripEdgeNoise(raw);
  if (!norm) return none;

  // Edge 1: an explicit ref is always the authority — context adds nothing.
  if (extractRefs(raw).length > 0 || extractConfidentialRefs(raw).length > 0) return none;

  // P-2: answer to a pending clarification question.
  const pend = ctx.pendingClarification;
  if (pend) {
    if (FIRST_RE.test(norm)) {
      return { message: raw, contextUsed: { resolvedClarification: `first → "${pend.faqQ1}"` }, clarificationFaqId: "__Q1__" };
    }
    if (pend.faqQ2 && SECOND_RE.test(norm)) {
      return { message: raw, contextUsed: { resolvedClarification: `second → "${pend.faqQ2}"` }, clarificationFaqId: "__Q2__" };
    }
    if (YES_RE.test(norm)) {
      // "Yes" accepts the first-mentioned candidate (spec §7.2).
      return { message: raw, contextUsed: { resolvedClarification: `yes → "${pend.faqQ1}"` }, clarificationFaqId: "__Q1__" };
    }
    // Quoted fragment of either candidate (≥10 chars to avoid junk hits).
    if (norm.length >= 10) {
      const q1 = pend.faqQ1.toLowerCase();
      const q2 = (pend.faqQ2 || "").toLowerCase();
      const in1 = q1.includes(norm);
      const in2 = pend.faqQ2 ? q2.includes(norm) : false;
      if (in1 && !in2) {
        return { message: raw, contextUsed: { resolvedClarification: `fragment → "${pend.faqQ1}"` }, clarificationFaqId: "__Q1__" };
      }
      if (in2 && !in1) {
        return { message: raw, contextUsed: { resolvedClarification: `fragment → "${pend.faqQ2}"` }, clarificationFaqId: "__Q2__" };
      }
    }
    // Anything else: normal pipeline (spec edge 3 keeps single-slot state,
    // which simply expires on the next exchange).
  }

  if (!ctx.lastRefs.length) return none;

  // P-3: "the other one" binds only with exactly 2 refs; otherwise ask.
  if (OTHER_ONE_RE.test(norm)) {
    if (ctx.lastRefs.length === 2) {
      const other = ctx.lastRefs[1];
      return { message: `${raw} ${other}`, contextUsed: { boundRef: other } };
    }
    return { message: raw, contextUsed: { resolvedClarification: "ask-which" }, askWhich: [...ctx.lastRefs] };
  }

  // P-1: pronoun binding on short follow-ups ("cancel it", "status nito").
  const words = norm.split(" ").length;
  if (words <= 8 && PRONOUN_RE.test(norm)) {
    const ref = ctx.lastRefs[0];
    return {
      message: raw.replace(PRONOUN_RE, ref),
      contextUsed: { boundRef: ref },
    };
  }

  return none;
}

/** Map a "__Q1__"/"__Q2__" marker back to the pending question text. */
export function clarificationQuestion(ctx: ChatContext, marker: string | null | undefined): string | null {
  if (!ctx.pendingClarification || !marker) return null;
  if (marker === "__Q1__") return ctx.pendingClarification.faqQ1;
  if (marker === "__Q2__") return ctx.pendingClarification.faqQ2 || null;
  return null;
}

/** Re-export for callers that only need analysis (guidance-verb checks). */
export { analyzeMessage };
