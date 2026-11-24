import { linksForDataSource } from "./assistant";
import type { StatusItem } from "./assistant-data";
import {
  matchStarterIntent as matchWordsStarterIntent,
  normalizeStarterIntent as normalizeWordsStarterIntent,
  type StarterIntent as WordsStarterIntent,
} from "./assistant-words";

// Contextual action pills (docs/ai-assistant-contextual-pills-spec.md).
//
// Pills render under the LATEST bot message only. Labels are verb-first,
// max 4 per reply, and support deep-links (with optional route params),
// direct QR pass viewing, direct rescheduling, follow-up prompts, and
// prefilled Help Desk ticket escalation.

export type AssistantPill =
  | { label: string; action: { type: "navigate"; target: string; params?: Record<string, string> } }
  | { label: string; action: { type: "view_qr"; code: string } }
  | { label: string; action: { type: "reschedule"; code: string } }
  | { label: string; action: { type: "ask"; prompt: string } }
  | { label: string; action: { type: "ticket"; prefill?: { category: string; subject: string; message: string } } }
  | { label: string; action: { type: "tickets" } };

export const MAX_PILLS = 4;

const NAV = (label: string, target: string, params?: Record<string, string>): AssistantPill => ({
  label,
  action: params ? { type: "navigate", target, params } : { type: "navigate", target },
});
const ASK = (label: string, prompt: string): AssistantPill => ({ label, action: { type: "ask", prompt } });

export const STARTER_PILLS: AssistantPill[] = [
  NAV("Book / Request", "page-appointment-book"),
  NAV("Upcoming Visits", "page-appointment", { filter: "upcoming" }),
  ASK("Check my status", "What's the status of my appointments and requests?"),
  ASK("Offline QR Pass", "How do I get my offline appointment QR pass?"),
];

const CATEGORY_PILLS: Array<{ match: RegExp; pills: AssistantPill[] }> = [
  {
    match: /qr|scanner/i,
    pills: [
      NAV("Upcoming Visits", "page-appointment", { filter: "upcoming" }),
      ASK("Check my appointments", "What's the status of my appointment?"),
      ASK("SSO office hours", "What are the SSO office hours?"),
    ],
  },
  {
    match: /appoint/i,
    pills: [
      NAV("Book Appointment", "page-appointment-book"),
      NAV("My Appointments", "page-appointment", { filter: "upcoming" }),
      ASK("Offline QR Pass", "How do I get my offline appointment QR pass?"),
      ASK("SSO office hours", "What are the SSO office hours?"),
    ],
  },
  {
    match: /\bid\b|identification/i,
    pills: [
      NAV("Open ID Application", "page-idapp"),
      NAV("Get Affidavit Form", "page-forms"),
      ASK("What to bring", "What do I need to bring when claiming my ID?"),
    ],
  },
  {
    match: /event/i,
    pills: [
      NAV("Student Bulletin", "page-bulletin"),
      NAV("Get Clearance Form", "page-forms"),
      ASK("Filing lead time", "How early should our org file an event request?"),
    ],
  },
  {
    match: /document|request|authentication|excuse|visit|service/i,
    pills: [
      NAV("File a Request", "page-appointment-book"),
      NAV("Track My Requests", "page-appointment", { filter: "pending" }),
      ASK("Check my status", "What's the status of my requests?"),
    ],
  },
  {
    match: /account|security|password|profile/i,
    pills: [
      NAV("Account Settings", "page-account"),
      ASK("Password rules", "What are the password requirements for STARS accounts?"),
      { label: "Contact Support", action: { type: "ticket" } },
    ],
  },
  {
    match: /general|announce|bulletin|office|hour/i,
    pills: [
      NAV("Book / Request", "page-appointment-book"),
      NAV("Student Bulletin", "page-bulletin"),
      NAV("Forms & Downloads", "page-forms"),
      ASK("SSO office hours", "What are the SSO office hours?"),
    ],
  },
];

const DEFAULT_PILLS: AssistantPill[] = [
  NAV("Book / Request", "page-appointment-book"),
  NAV("My Appointments", "page-appointment"),
  ASK("Check my status", "What's the status of my requests?"),
];

export function pillsForCategory(cat: string): AssistantPill[] {
  const entry = CATEGORY_PILLS.find((e) => e.match.test(String(cat || "")));
  return (entry ? entry.pills : DEFAULT_PILLS).slice(0, MAX_PILLS);
}

export const TICKET_PILLS: AssistantPill[] = [
  { label: "Create Support Ticket", action: { type: "ticket" } },
  { label: "View My Tickets", action: { type: "tickets" } },
];

const LINK_PILL_LABELS: Record<string, string> = {
  "page-student": "Open Dashboard",
  "page-appointment": "My Appointments",
  "page-appointment-book": "Book / Request",
  "page-idapp": "ID Application",
  "page-bulletin": "Student Bulletin",
  "page-helpdesk": "Help Desk",
  "page-forms": "Forms & Downloads",
  "page-account": "Account Settings",
  "page-referral": "Referrals",
  "page-complaint": "Complaints",
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

export function pillsForData(items: StatusItem[]): AssistantPill[] {
  const pills: AssistantPill[] = [];
  const seen = new Set<string>();

  // Offer direct QR pass pill for any active appointment item.
  const activeAppt = (items || []).find(
    (i) => i.kind === "appointment" && !["CANCELLED", "NO_SHOW", "Cancelled", "No Show"].includes(i.status)
  );
  if (activeAppt) {
    pills.push({ label: `Show QR Pass (${activeAppt.ref})`, action: { type: "view_qr", code: activeAppt.ref } });
    seen.add(`qr:${activeAppt.ref}`);
  }

  for (const item of items || []) {
    const link = linksForDataSource(item.dataSource)[0];
    if (link && !seen.has(link.target)) {
      seen.add(link.target);
      pills.push(NAV(LINK_PILL_LABELS[link.target] || link.label, link.target));
    }
  }
  const hasTickets = (items || []).some((i) => i.kind === "ticket");
  const out = hasTickets ? [...pills, ...TICKET_PILLS] : pills;
  return out.slice(0, MAX_PILLS);
}

// --- Starter intents (re-exported from assistant-words.ts) ---

export type StarterIntent = WordsStarterIntent;

export function normalizeStarterIntent(message: string): string {
  return normalizeWordsStarterIntent(message);
}

export function matchStarterIntent(message: string): StarterIntent | null {
  return matchWordsStarterIntent(message);
}

export const GREETING_REPLY =
  "Hello! 👋 I'm your **PUP San Pedro STARS Assistant**.\n\n" +
  "I can help you with:\n" +
  "• Booking visits, rescheduling, and downloading your **offline QR pass**\n" +
  "• Filing & tracking **Student IDs, Authentication, Excuse Slips, and Events**\n" +
  "• Checking live status — just paste a code like `APT-001`, `EXC-...`, or `TKT-...`\n" +
  "• Escalating concerns directly to an SSO **Help Desk ticket**\n\n" +
  "Pick a quick action below or type your question in English, Tagalog, or Taglish!";

export const CAPABILITIES_REPLY =
  "Here's everything I can help you with at PUP San Pedro SSO:\n" +
  "• **Appointments & QR Passes** — book General Visits, Event Consultations, or Counseling; download/print offline QR passes; reschedule or cancel\n" +
  "• **Document & ID Requests** — step-by-step guidance for Authentication, Excuse Slips, and New/Lost Student IDs\n" +
  "• **Live Record Lookup** — check your own appointments, pickups, requests, or tickets (paste any `APT-`, `AUT-`, `EXC-`, `GEN-`, `IDA-`, `EVT-`, or `TKT-` code)\n" +
  "• **Account & Security** — registration OTP, strong password rules, and profile updates\n" +
  "• **Help Desk Escalation** — open a prefilled support ticket for anything that needs staff action\n\n" +
  "What would you like to do next?";

export const THANKS_REPLY =
  "You're very welcome! 😊 Glad I could help. If you need to check a booking, grab your QR pass, or track another request, just message me anytime.";

export const FAREWELL_REPLY =
  "Take care and good luck with your PUP San Pedro transactions! 👋 Don't forget to save or print your offline QR pass before visiting the SSO.";
