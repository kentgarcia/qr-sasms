import { linksForDataSource } from "./assistant";
import type { StatusItem } from "./assistant-data";
import {
  matchStarterIntent as matchWordsStarterIntent,
  normalizeStarterIntent as normalizeWordsStarterIntent,
  type StarterIntent as WordsStarterIntent,
} from "./assistant-words";

// Contextual action pills (docs/ai-assistant-contextual-pills-spec.md).
//
// Pills are the single CTA system rendered under the LATEST bot message only.
// Labels are verb-first, max 4 per reply. Navigation reuses the link
// allowlist; `ask` prompts are pinned to questions that score high on seeded
// FAQs (see spec §P-2); `ticket` opens the review modal.

export type AssistantPill =
  | { label: string; action: { type: "navigate"; target: string } }
  | { label: string; action: { type: "ask"; prompt: string } }
  | { label: string; action: { type: "ticket"; prefill?: { category: string; subject: string; message: string } } }
  | { label: string; action: { type: "tickets" } };

export const MAX_PILLS = 4;

const NAV = (label: string, target: string): AssistantPill => ({ label, action: { type: "navigate", target } });
const ASK = (label: string, prompt: string): AssistantPill => ({ label, action: { type: "ask", prompt } });

export const STARTER_PILLS: AssistantPill[] = [
  NAV("Book an appointment", "page-appointment"),
  NAV("Request a document", "page-appointment-book"),
  ASK("Check a request", "What's the status of my requests?"),
  { label: "Report a problem", action: { type: "ticket" } },
];

const CATEGORY_PILLS: Array<{ match: RegExp; pills: AssistantPill[] }> = [
  {
    match: /appoint/i,
    pills: [
      NAV("Book an appointment", "page-appointment"),
      NAV("View my appointments", "page-appointment"),
      ASK("Office hours", "What are the SSO office hours?"),
    ],
  },
  {
    match: /\bid\b|identification/i,
    pills: [
      NAV("Apply for ID", "page-idapp"),
      ASK("What to bring", "What do I need to bring when claiming my ID?"),
    ],
  },
  {
    match: /event/i,
    pills: [
      NAV("View bulletin", "page-bulletin"),
      ASK("Filing lead time", "How early should our org file an event request?"),
    ],
  },
  {
    match: /document|request|authentication|excuse|visit|service/i,
    pills: [
      NAV("Request a document", "page-appointment-book"),
      ASK("Check my request", "What's the status of my request?"),
    ],
  },
  {
    // Catch-all for General / announcements / office-info answers so they
    // never render bare. Kept last — earlier entries win.
    match: /general|announce|bulletin|office|hour/i,
    pills: [
      NAV("Book an appointment", "page-appointment"),
      NAV("View bulletin", "page-bulletin"),
      ASK("Office hours", "What are the SSO office hours?"),
    ],
  },
];

const DEFAULT_PILLS: AssistantPill[] = [
  NAV("Book an appointment", "page-appointment"),
  ASK("Check a request", "What's the status of my requests?"),
];

export function pillsForCategory(cat: string): AssistantPill[] {
  const entry = CATEGORY_PILLS.find((e) => e.match.test(String(cat || "")));
  return (entry ? entry.pills : DEFAULT_PILLS).slice(0, MAX_PILLS);
}

export const TICKET_PILLS: AssistantPill[] = [
  { label: "View all tickets", action: { type: "tickets" } },
  { label: "Create a new ticket", action: { type: "ticket" } },
];

// Rule answers: pills mirror the buttons shown under the reply (one NAV per
// link), plus an optional ask follow-up and/or the ticket pair. Short
// verb-first labels; capped like every other set.
const LINK_PILL_LABELS: Record<string, string> = {
  "page-appointment": "View my appointments",
  "page-appointment-book": "Book an appointment",
  "page-idapp": "Apply for ID",
  "page-bulletin": "View bulletin",
  "page-helpdesk": "Open Help Desk",
  "page-forms": "Get a form",
};

export type RuleFollowAsk = { label: string; prompt: string };

export function pillsForRuleLinks(
  links: Array<{ label: string; target: string }>,
  followAsk?: RuleFollowAsk | null,
  ticketPair?: boolean
): AssistantPill[] {
  const out: AssistantPill[] = [];
  const seen = new Set<string>();
  for (const l of links || []) {
    if (!l || seen.has(l.target)) continue;
    seen.add(l.target);
    out.push(NAV(LINK_PILL_LABELS[l.target] || l.label, l.target));
  }
  if (followAsk) out.push(ASK(followAsk.label, followAsk.prompt));
  if (ticketPair) out.push(...TICKET_PILLS);
  return out.slice(0, MAX_PILLS);
}

// Data answers: one nav pill per distinct record kind (from the allowlist
// links) plus the ticket pair when tickets are involved. Nav pills are kept
// (not dropped) so ticket answers still offer the Help Desk jump.
export function pillsForData(items: StatusItem[]): AssistantPill[] {
  const pills: AssistantPill[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const link = linksForDataSource(item.dataSource)[0];
    if (link && !seen.has(link.target)) {
      seen.add(link.target);
      pills.push(NAV(link.label, link.target));
    }
  }
  const hasTickets = (items || []).some((i) => i.kind === "ticket");
  const out = hasTickets ? [...pills, ...TICKET_PILLS] : pills;
  return out.slice(0, MAX_PILLS);
}

// --- Minimal greeting/capabilities handling -------------------------------
// Word-recognition layer (assistant-words.ts) is the single source of truth
// for starter phrases — TL variants + "po" tolerance + typo repair included.
// Kept re-exported here so existing imports keep working.

export type StarterIntent = WordsStarterIntent;

export function normalizeStarterIntent(message: string): string {
  return normalizeWordsStarterIntent(message);
}

export function matchStarterIntent(message: string): StarterIntent | null {
  return matchWordsStarterIntent(message);
}

export const GREETING_REPLY =
  "Hello! 👋 I'm the STARS assistant — I can answer questions about student " +
  "services, check the status of your tickets and requests, or help you file " +
  "a support ticket.\n\nTry asking things like:\n" +
  "• \"How do I request an excuse slip?\"\n" +
  "• \"What's the status of my ticket?\"\n" +
  "• \"Where do I book an appointment?\"";

export const CAPABILITIES_REPLY =
  "Here's what I can do:\n" +
  "• Answer questions about appointments, documents, IDs, and events\n" +
  "• Check the status of your tickets, requests, and appointments — paste a " +
  "reference code like TKT-… or APT-… for a direct lookup\n" +
  "• File a support ticket for anything I can't resolve\n\n" +
  "What would you like to do?";

export const THANKS_REPLY =
  "You're welcome! 😊 I'm happy to help. If you need anything else — " +
  "appointments, requests, IDs, or events — just ask.";

export const FAREWELL_REPLY =
  "Goodbye! 👋 Take care, and good luck with your transactions. " +
  "I'll be here whenever you need help.";
