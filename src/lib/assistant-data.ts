import { prisma } from "./prisma";
import { serviceLabel } from "./appointments";
import { draftSubject, extractRefs } from "./assistant";
import {
  analyzeMessage,
  extractConfidentialRefs,
  hasBillingIntentWords,
} from "./assistant-words";
import { CONFIDENTIAL_REDIRECT_REPLY } from "./assistant-rules";

// Phase 2 of docs/ai-assistant-ticket-escalation-spec.md.
//
// "User-Specific Information" (spec §4C): when the knowledge base cannot
// answer with high confidence and the question looks like a status inquiry,
// answer from the student's own records instead of escalating.
//
// Safety rules:
// - Every lookup is scoped to the caller's student number. A reference code
//   belonging to someone else (or not existing) yields the same "couldn't
//   find under your account" reply — never an existence oracle.
// - Referral and Complaint records are NEVER read here. Psychological
//   referrals carry free-text concerns under confidentiality rules, and
//   complaints are access-controlled; status questions about them get the
//   standard fallback + escalation (spec §12.4).
// - There is no billing/payments model in this portal, so balance questions
//   get an explicit "no access" notice, not a guess.

const STATUS_PATTERNS = [
  /\bstatus\b/,
  /\bmy\s+(ticket|request|appointment|application|id|event)\b/,
  /\bwhere\s+(is|are)\s+my\b/,
  /\b(pending|approved|waiting|in\s+progress|resolved)\b/,
  /\btrack\b/,
  /\bfollow[-\s]?up\b/,
  /\bhappening with\b/,
  /\bupdate\s+(on|about|for)\b/,
  /\b(confirm|confirmed|confirmation)\b.*\b(my|appointment|booking)\b/,
  /\bmy\s+(appointment|booking)\b.*\b(confirm|confirmed|confirmation)\b/,
];

const BILLING_PATTERNS = [
  /\bbalance\b/,
  /\boutstanding\b/,
  /\btuition\b/,
  /\bpayment\b/,
  /\bpay\b/,
  /\bfee\b/,
  /\breceipt\b/,
];

const TICKET_WORDS = /\bticket\b|help\s*desk|\btkt\b/;
const APPOINTMENT_WORDS = /\bappointment\b|booking|booked|slot|visit|check[-\s]?in/;
const REQUEST_WORDS = /\brequest\b|application|document|excuse|authentication|event\b/;

// Rule-based spec §6.1 / T-8·T-9: REF-/CMP- references (and bare
// referral/complaint status questions) never touch the database. The route
// checks this before any SIS lookup so confidential rows are unreadable
// through chat by construction.
export function hasConfidentialRef(question: string): boolean {
  return extractConfidentialRefs(question).length > 0;
}

export function confidentialRedirect(question: string): StatusAnswer {
  return {
    reply: CONFIDENTIAL_REDIRECT_REPLY,
    dataSource: null,
    items: [],
    totalTickets: null,
    ticketDraft: { category: "", subject: draftSubject(question), message: question.trim() },
  };
}

export function hasStatusIntent(question: string): boolean {
  const q = String(question || "").toLowerCase();
  if (extractRefs(question).length > 0) return true;
  if (STATUS_PATTERNS.some((re) => re.test(q))) return true;
  // Word-recognition layer (TL synonyms + typo tolerance + plurals):
  // "my tickets", "nasaan ang request ko?", "kamusta appointment ko?".
  const a = analyzeMessage(question);
  if (a.tokenSet.has("status")) return true;
  const mine = /\b(my|ko|akin|aking|namin)\b/.test(a.normalized);
  if (mine && (a.tokenSet.has("ticket") || a.tokenSet.has("appointment") || a.tokenSet.has("request") || a.tokenSet.has("authentication") || a.tokenSet.has("excuse") || a.tokenSet.has("generalvisit") || a.tokenSet.has("id") || a.tokenSet.has("lostid") || a.tokenSet.has("event"))) {
    return true;
  }
  return false;
}

export function hasBillingIntent(question: string): boolean {
  if (BILLING_PATTERNS.some((re) => re.test(String(question || "").toLowerCase()))) return true;
  return hasBillingIntentWords(question);
}

export type StatusItem = {
  kind: "ticket" | "request" | "idapp" | "event" | "appointment";
  ref: string;
  title: string;
  status: string;
  meta: string[];
  dataSource: string;
};

export type AssistantCard = {
  kind: StatusItem["kind"];
  ref: string;
  title: string;
  status: string;
  meta: string[];
  link: { label: string; target: string } | null;
};

export type StatusAnswer = {
  reply: string;
  // Machine-readable provenance for analytics (stored on ChatMessage).
  dataSource: string | null;
  // Structured mirror of the reply for answer cards (C-3). Text stays authoritative.
  items: StatusItem[];
  // Total own tickets (for the "You currently have N tickets" line). Set only
  // on ticket-involved answers; null otherwise.
  totalTickets: number | null;
  // Present when nothing was found — the caller offers escalation.
  ticketDraft: { category: string; subject: string; message: string } | null;
};

function notFoundReply(ref: string, question: string): StatusAnswer {
  return {
    reply:
      `I couldn't find ${ref} under your account. If the reference is correct, ` +
      `an SSO staff member can look into it — would you like to create a support ticket?`,
    dataSource: null,
    items: [],
    totalTickets: null,
    ticketDraft: { category: "", subject: draftSubject(question), message: question.trim() },
  };
}

// Prefix the ticket count line on ticket-involved answers (pills spec P-4).
async function withTicketCount(ans: StatusAnswer, sn: string): Promise<StatusAnswer> {
  const total = await prisma.ticket.count({ where: { sn } });
  return {
    ...ans,
    totalTickets: total,
    reply: `You currently have ${total} ticket${total === 1 ? "" : "s"}.\n\n${ans.reply}`,
  };
}

function describeTicket(t: { id: string; subject: string; category: string; status: string; msgs: unknown; createdAt: Date }): string {
  const msgs = Array.isArray(t.msgs) ? t.msgs : [];
  const last = msgs.length ? (msgs[msgs.length - 1] as { ts?: string }) : null;
  return [
    `Ticket ${t.id}`,
    `Subject: ${t.subject || "—"}`,
    `Category: ${t.category || "—"}`,
    `Status: ${t.status}`,
    `Last update: ${last?.ts || t.createdAt.toLocaleString("en-PH")}`,
  ].join("\n");
}

function describeServiceRequest(r: { id: string; service: string; subject: string; status: string; remarks: string }): string {
  const lines = [
    `${r.service} request ${r.id}`,
    r.subject ? `Subject: ${r.subject}` : null,
    `Status: ${r.status}`,
    r.remarks ? `Staff remarks: ${r.remarks}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function describeAppointment(a: { code: string; serviceType: string; dateLabel: string; time: string; status: string }): string {
  return `${a.code} · ${serviceLabel(a.serviceType)} · ${a.dateLabel} ${a.time} · Status: ${a.status}`;
}

async function lookupRef(
  ref: string,
  sn: string,
  question: string
): Promise<StatusAnswer | null> {
  const prefix = ref.split("-")[0];
  if (prefix === "TKT") {
    const t = await prisma.ticket.findFirst({ where: { id: ref, sn } });
    if (!t) return notFoundReply(ref, question);
    const msgs = Array.isArray(t.msgs) ? t.msgs : [];
    const last = msgs.length ? (msgs[msgs.length - 1] as { ts?: string }) : null;
    return {
      reply: describeTicket(t),
      dataSource: `ticket:${t.id}`,
      items: [
        {
          kind: "ticket",
          ref: t.id,
          title: t.subject || t.id,
          status: t.status,
          meta: [
            t.category ? `Category: ${t.category}` : null,
            `Last update: ${last?.ts || t.createdAt.toLocaleString("en-PH")}`,
          ].filter((x): x is string => Boolean(x)),
          dataSource: `ticket:${t.id}`,
        },
      ],
      totalTickets: null,
      ticketDraft: null,
    };
  }
  if (prefix === "APT") {
    const a = await prisma.queueEntry.findFirst({ where: { code: ref, studentId: sn } });
    if (!a) return notFoundReply(ref, question);
    return {
      reply: describeAppointment(a),
      dataSource: `appointment:${a.code}`,
      items: [
        {
          kind: "appointment",
          ref: a.code,
          title: serviceLabel(a.serviceType),
          status: a.status,
          meta: [`${a.dateLabel} ${a.time}`.trim()],
          dataSource: `appointment:${a.code}`,
        },
      ],
      totalTickets: null,
      ticketDraft: null,
    };
  }
  if (prefix === "IDA") {
    const r = await prisma.idApplication.findFirst({ where: { id: ref, sn } });
    if (!r) return notFoundReply(ref, question);
    const lines = [
      `ID Application ${r.id} (${r.type || "—"})`,
      `Status: ${r.status}`,
      r.remarks ? `Staff remarks: ${r.remarks}` : null,
      r.pickupDate ? `Pickup: ${r.pickupDate} ${r.pickupTime}`.trim() : null,
    ].filter(Boolean);
    return {
      reply: lines.join("\n"),
      dataSource: `idapp:${r.id}`,
      items: [
        {
          kind: "idapp",
          ref: r.id,
          title: `ID Application (${r.type || "—"})`,
          status: r.status,
          meta: [
            r.remarks ? `Staff remarks: ${r.remarks}` : null,
            r.pickupDate ? `Pickup: ${r.pickupDate} ${r.pickupTime}`.trim() : null,
          ].filter((x): x is string => Boolean(x)),
          dataSource: `idapp:${r.id}`,
        },
      ],
      totalTickets: null,
      ticketDraft: null,
    };
  }
  if (prefix === "EVT") {
    const r = await prisma.eventRequest.findFirst({ where: { id: ref, sn } });
    if (!r) return notFoundReply(ref, question);
    return {
      reply: [`Event request ${r.id} — ${r.title || "—"}`, `Status: ${r.status}`].join("\n"),
      dataSource: `event:${r.id}`,
      items: [
        {
          kind: "event",
          ref: r.id,
          title: r.title || r.id,
          status: r.status,
          meta: [],
          dataSource: `event:${r.id}`,
        },
      ],
      totalTickets: null,
      ticketDraft: null,
    };
  }
  if (prefix === "AUT" || prefix === "EXC" || prefix === "GEN") {
    const r = await prisma.serviceRequest.findFirst({ where: { id: ref, sn } });
    if (!r) return notFoundReply(ref, question);
    return {
      reply: describeServiceRequest(r),
      dataSource: `request:${r.id}`,
      items: [
        {
          kind: "request",
          ref: r.id,
          title: r.subject ? `${r.service} — ${r.subject}` : `${r.service} request`,
          status: r.status,
          meta: r.remarks ? [`Staff remarks: ${r.remarks}`] : [],
          dataSource: `request:${r.id}`,
        },
      ],
      totalTickets: null,
      ticketDraft: null,
    };
  }
  return null;
}

export const ACTIVE_APPOINTMENT = ["BOOKED", "RESCHEDULED", "CHECKED_IN"];

export async function answerStatusQuestion(question: string, sn: string): Promise<StatusAnswer | null> {
  const q = String(question || "");
  if (!hasStatusIntent(q)) return null;

  // Direct reference lookup first — most precise.
  const refs = extractRefs(q).slice(0, 3);
  if (refs.length) {
    const answers: string[] = [];
    const sources: string[] = [];
    const items: StatusItem[] = [];
    for (const ref of refs) {
      const ans = await lookupRef(ref, sn, q);
      if (!ans) continue;
      if (ans.ticketDraft) return ans; // not found under this account — stop, don't leak the rest.
      answers.push(ans.reply);
      if (ans.dataSource) sources.push(ans.dataSource);
      items.push(...ans.items);
    }
    if (answers.length) {
      const ans: StatusAnswer = { reply: answers.join("\n\n"), dataSource: sources.join(","), items, totalTickets: null, ticketDraft: null };
      // Count line only when a ticket record was actually involved.
      if (refs.some((r) => r.startsWith("TKT"))) return withTicketCount(ans, sn);
      return ans;
    }
    return null;
  }

  const lower = q.toLowerCase();
  // Scoped ("my ticket", "my appointment") vs unscoped ("what's happening
  // with my problem?") — unscoped shows tickets + recent requests + appointment.
  // Token scopes (plural/TL tolerant) supplement the legacy regexes.
  const tokens = analyzeMessage(q).tokenSet;
  const ticketScope = TICKET_WORDS.test(lower) || tokens.has("ticket");
  const apptScope = APPOINTMENT_WORDS.test(lower) || tokens.has("appointment");
  const reqScope =
    REQUEST_WORDS.test(lower) ||
    tokens.has("request") || tokens.has("authentication") || tokens.has("excuse") ||
    tokens.has("generalvisit") || tokens.has("id") || tokens.has("lostid") || tokens.has("event");
  const scoped = ticketScope || apptScope || reqScope;
  const wantTickets = ticketScope || !scoped;
  const wantAppointments = apptScope || !scoped;
  const wantRequests = reqScope || !scoped;

  const blocks: string[] = [];
  const sources: string[] = [];
  const items: StatusItem[] = [];

  if (wantTickets) {
    const tickets = await prisma.ticket.findMany({
      where: { sn },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    if (tickets.length) {
      blocks.push(tickets.map(describeTicket).join("\n\n"));
      sources.push(`tickets:${tickets.map((t) => t.id).join(",")}`);
      for (const t of tickets) {
        const msgs = Array.isArray(t.msgs) ? t.msgs : [];
        const last = msgs.length ? (msgs[msgs.length - 1] as { ts?: string }) : null;
        items.push({
          kind: "ticket",
          ref: t.id,
          title: t.subject || t.id,
          status: t.status,
          meta: [
            t.category ? `Category: ${t.category}` : null,
            `Last update: ${last?.ts || t.createdAt.toLocaleString("en-PH")}`,
          ].filter((x): x is string => Boolean(x)),
          dataSource: `ticket:${t.id}`,
        });
      }
    }
  }
  if (wantRequests) {
    const [svc, ida, evt] = await Promise.all([
      prisma.serviceRequest.findMany({ where: { sn }, orderBy: { createdAt: "desc" }, take: 3 }),
      prisma.idApplication.findMany({ where: { sn }, orderBy: { createdAt: "desc" }, take: 2 }),
      prisma.eventRequest.findMany({ where: { sn }, orderBy: { createdAt: "desc" }, take: 2 }),
    ]);
    const reqBlocks: string[] = [];
    for (const r of svc) {
      reqBlocks.push(describeServiceRequest(r));
      sources.push(`request:${r.id}`);
      items.push({
        kind: "request",
        ref: r.id,
        title: r.subject ? `${r.service} — ${r.subject}` : `${r.service} request`,
        status: r.status,
        meta: r.remarks ? [`Staff remarks: ${r.remarks}`] : [],
        dataSource: `request:${r.id}`,
      });
    }
    for (const r of ida) {
      reqBlocks.push(`ID Application ${r.id} (${r.type || "—"})\nStatus: ${r.status}`);
      sources.push(`idapp:${r.id}`);
      items.push({
        kind: "idapp",
        ref: r.id,
        title: `ID Application (${r.type || "—"})`,
        status: r.status,
        meta: [],
        dataSource: `idapp:${r.id}`,
      });
    }
    for (const r of evt) {
      reqBlocks.push(`Event request ${r.id} — ${r.title || "—"}\nStatus: ${r.status}`);
      sources.push(`event:${r.id}`);
      items.push({
        kind: "event",
        ref: r.id,
        title: r.title || r.id,
        status: r.status,
        meta: [],
        dataSource: `event:${r.id}`,
      });
    }
    if (reqBlocks.length) blocks.push(reqBlocks.join("\n\n"));
  }
  if (wantAppointments) {
    const appt = await prisma.queueEntry.findFirst({
      where: { studentId: sn, status: { in: ACTIVE_APPOINTMENT } },
      orderBy: { createdAt: "desc" },
    });
    if (appt) {
      blocks.push(`Upcoming appointment\n${describeAppointment(appt)}`);
      sources.push(`appointment:${appt.code}`);
      items.push({
        kind: "appointment",
        ref: appt.code,
        title: serviceLabel(appt.serviceType),
        status: appt.status,
        meta: [`${appt.dateLabel} ${appt.time}`.trim()],
        dataSource: `appointment:${appt.code}`,
      });
    }
  }

  if (!blocks.length) {
    return {
      reply:
        "I couldn't find any tickets, requests, or appointments under your account. " +
        "If you expected to see something here, an SSO staff member can check — " +
        "would you like to create a support ticket?",
      dataSource: null,
      items: [],
      totalTickets: null,
      ticketDraft: { category: "", subject: draftSubject(q), message: q.trim() },
    };
  }
  const digest: StatusAnswer = { reply: blocks.join("\n\n"), dataSource: sources.join(","), items, totalTickets: null, ticketDraft: null };
  if (wantTickets && items.some((i) => i.kind === "ticket")) return withTicketCount(digest, sn);
  return digest;
}

export function billingNotice(question: string): StatusAnswer {
  return {
    reply:
      "I don't have access to billing or payment records, so I can't check balances directly.\n\n" +
      "You can create a support ticket and the appropriate office will be able to assist you.",
    dataSource: null,
    items: [],
    totalTickets: null,
    ticketDraft: { category: "", subject: draftSubject(question), message: question.trim() },
  };
}
