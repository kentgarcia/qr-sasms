// Rule-based chatbot — transaction rule catalog (docs/ai-assistant-rulebased-chatbot-spec.md §4).
//
// Deterministic process guidance for every SSO business transaction. The bot
// explains and routes; it never books, cancels, approves, or edits.
// Links use allowlist targets only; pills reuse the existing pill sets via
// a hint the chat route resolves (avoids import cycles).

import { analyzeMessage, matchStarterIntent, type WordAnalysis } from "./assistant-words";

export type RuleLink = { label: string; target: string };

export type RuleFollowAsk = { label: string; prompt: string };

export type TxRule = {
  id: string;
  domain: string;
  intent: string;
  needs: string[];
  wants: string[];
  phrases: string[];
  reply: string;
  links: RuleLink[];             // allowlist targets only (buttons under the reply)
  followAsk: RuleFollowAsk | null; // one ask-pill follow-up (prompt must resolve on its own)
  ticketPill: boolean;           // append the View-all / Create-ticket pair
  examples: string[];
};

const APPT = { label: "Open Appointments", target: "page-appointment" } as RuleLink;
const IDAPP = { label: "Open ID Application", target: "page-idapp" } as RuleLink;
const BULLETIN = { label: "Open Student Bulletin", target: "page-bulletin" } as RuleLink;
const REQUESTS = { label: "Open Book Appointment", target: "page-appointment-book" } as RuleLink;
const HELPDESK = { label: "Open Help Desk", target: "page-helpdesk" } as RuleLink;
const FORMS = { label: "Open Forms & Downloads", target: "page-forms" } as RuleLink;

export const CONFIDENTIAL_REDIRECT_REPLY =
  "For privacy, I can't show referral or complaint details here — those records are confidential and only SSO staff can access them.\n\n" +
  "If you need help with a personal concern, please visit the SSO office directly. " +
  "For anything else, you can create a support ticket and the appropriate office will assist you.";

export const BILLING_RULE_REPLY =
  "I don't have access to billing or payment records, so I can't check balances directly.\n\n" +
  "You can create a support ticket and the appropriate office will be able to assist you.";

export const GUIDE_NUDGE =
  "Sure — tell me what you need help with, and I'll walk you through it.\n\n" +
  "Try asking things like:\n" +
  "• \"Walk me through requesting an excuse slip\"\n" +
  "• \"Guide me on applying for a new ID\"\n" +
  "• \"Walk me through booking an appointment\"";

// Rank order: score first, lowest rule id breaks ties (deterministic).
export const TX_RULES: TxRule[] = [
  // ── T-1 booking ──────────────────────────────────────────────
  {
    id: "book-appointment",
    domain: "T-1",
    intent: "book_appointment",
    needs: ["appointment"],
    wants: ["appointment", "book", "schedule", "slot", "date", "time", "walkin", "generalvisit", "event", "referral", "hours", "tomorrow", "today", "week"],
    phrases: ["book an appointment", "pa-book", "pabook", "walk in", "walk-in"],
    reply:
      "To book an appointment:\n" +
      "1. Open Appointments and choose a service (General Visit, Event, or Psychological Intervention — ID, Authentication, and Excuse Slip are request-first, see below).\n" +
      "2. Pick a weekday (Monday–Friday, current or next month) and an available time slot.\n" +
      "3. Confirm — your booking appears under My Appointments with its APT- code.\n\n" +
      "One active booking per student per date. Slots are limited per service, and the office is closed on holidays. Office hours: Monday–Friday, 8:00 AM – 5:00 PM.",
    links: [APPT],
    followAsk: { label: "Office hours", prompt: "What are the SSO office hours?" },
    ticketPill: false,
    examples: ["apointment bukas?", "pa-book naman", "san magpa appointment", "where do I book an appointment?"],
  },
  {
    id: "appointment-reschedule",
    domain: "T-3",
    intent: "reschedule_appointment",
    needs: ["reschedule"],
    wants: ["reschedule", "appointment", "date", "slot", "time", "limit", "cancel"],
    phrases: ["reschedule", "rebook"],
    reply:
      "To reschedule an appointment:\n" +
      "1. Open Appointments → My Appointments and choose Reschedule on your booking.\n" +
      "2. Pick a new weekday and time slot where the service is offered.\n" +
      "3. Confirm — your APT- code stays the same.\n\n" +
      "Up to 2 reschedules per appointment and a 24-hour cutoff on the original slot apply. Cancelled codes are never reused; past and no-show visits are read-only history.",
    links: [APPT],
    followAsk: { label: "Check my appointment", prompt: "What's the status of my appointment?" },
    ticketPill: false,
    examples: ["how to reschedule my appointment?", "paano mag rebook?", "move my booking to next week"],
  },
  {
    id: "appointment-cancel",
    domain: "T-3",
    intent: "cancel_appointment",
    needs: ["cancel"],
    wants: ["cancel", "appointment", "book", "slot", "date", "refund"],
    phrases: ["cancel my appointment", "cancel booking"],
    reply:
      "To cancel an appointment:\n" +
      "1. Open Appointments → My Appointments and choose Cancel on your booking.\n" +
      "2. Give a reason if asked, then confirm.\n\n" +
      "A 24-hour cutoff applies. Cancelled codes are never reused, so just book a new slot when you're ready.",
    links: [APPT],
    followAsk: { label: "Check my appointment", prompt: "What's the status of my appointment?" },
    ticketPill: false,
    examples: ["how do I cancel my appointment?", "kansela appointment ko"],
  },
  // ── T-2 request-only lanes ───────────────────────────────────
  {
    id: "request-only-id",
    domain: "T-2",
    intent: "request_only_id",
    needs: ["id"],
    wants: ["id", "appointment", "book", "direct", "walkin", "schedule", "slot", "newid", "lostid"],
    phrases: ["book id", "walk in", "walk-in", "direct"],
    reply:
      "ID lanes are request-only — you can't book them directly:\n" +
      "1. File an ID Application first (New, or Lost with your OR receipt + signed Affidavit of Loss).\n" +
      "2. Track it: Pending → OR Verified → Approved → Processing → Ready for Claiming.\n" +
      "3. The SSO schedules your pickup when the ID is ready — no payment is required.",
    links: [IDAPP],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["can I book ID directly?", "walk in for new id?", "pa-book ng ID"],
  },
  {
    id: "request-only-auth",
    domain: "T-2",
    intent: "request_only_auth",
    needs: ["authentication"],
    wants: ["authentication", "appointment", "book", "direct", "walkin", "schedule", "slot", "visit"],
    phrases: ["walk in", "walk-in", "book authentication", "direct"],
    reply:
      "Authentication is request-first — you can't book it directly:\n" +
      "1. File an Authentication request via Book Appointment (purpose + copies).\n" +
      "2. Track it: Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed.\n" +
      "3. The SSO schedules your pickup when the documents are ready.",
    links: [REQUESTS],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["authentication walk in?", "can I book authentication directly?"],
  },
  {
    id: "request-only-excuse",
    domain: "T-2",
    intent: "request_only_excuse",
    needs: ["excuse"],
    wants: ["excuse", "appointment", "book", "direct", "walkin", "schedule", "slot", "visit"],
    phrases: ["walk in", "walk-in", "book excuse", "direct"],
    reply:
      "Excuse Slip is request-first — you can't book it directly:\n" +
      "1. File an Excuse Slip request via Book Appointment (purpose + copies).\n" +
      "2. Track it: Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed.\n" +
      "3. Bring supporting documents to your visit/pickup.",
    links: [REQUESTS],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["excuse slip walk in?", "book excuse directly?"],
  },
  // ── T-5 service requests ─────────────────────────────────────
  {
    id: "file-authentication",
    domain: "T-5",
    intent: "file_authentication",
    needs: ["authentication"],
    wants: ["authentication", "file", "request", "how", "apply", "copies", "purpose", "form"],
    phrases: ["how do i", "paano mag"],
    reply:
      "To file an Authentication request:\n" +
      "1. Open Book Appointment and choose Authentication.\n" +
      "2. Enter the purpose and number of copies, then submit.\n" +
      "3. Track it: Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed.\n" +
      "4. The SSO schedules your pickup when the documents are ready.",
    links: [REQUESTS],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["how do I request authentication?", "paano mag request ng authentication?", "authentication requirements"],
  },
  {
    id: "file-excuse",
    domain: "T-5",
    intent: "file_excuse",
    needs: ["excuse"],
    wants: ["excuse", "slip", "file", "request", "how", "apply", "copies", "purpose", "form"],
    phrases: ["how do i", "paano mag"],
    reply:
      "To file an Excuse Slip request:\n" +
      "1. Open Book Appointment and choose Excuse Slip.\n" +
      "2. Enter the purpose and number of copies, then submit.\n" +
      "3. Track it: Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed.\n" +
      "4. Bring supporting documents to your visit/pickup.",
    links: [REQUESTS],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["paano mag request ng excuse slip?", "how do I request an excuse slip?", "excusse slip please"],
  },
  {
    id: "file-general-visit",
    domain: "T-5",
    intent: "file_general_visit",
    needs: ["generalvisit"],
    wants: ["generalvisit", "file", "request", "how", "apply", "appointment", "visit", "book"],
    phrases: ["general visit"],
    reply:
      "To file a General Visit request:\n" +
      "1. Open Book Appointment and choose General Visit.\n" +
      "2. Enter your purpose, then pick a date and time slot as part of the request.\n" +
      "3. Track review under My Appointments; your visit details stay on the request itself.",
    links: [REQUESTS],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["how to file a general visit?", "general visit request steps"],
  },
  {
    id: "resubmit-request",
    domain: "T-5",
    intent: "resubmit_request",
    needs: ["resubmit"],
    wants: ["request", "revision", "need", "requirements", "authentication", "excuse", "generalvisit"],
    phrases: ["needs revision", "resubmit"],
    reply:
      "To resubmit a request sent back for revision:\n" +
      "1. Open My Appointments and find the request marked Needs Revision — read the staff remarks first.\n" +
      "2. Choose Resubmit, fix or attach what's asked, then submit again.\n" +
      "3. It returns to Pending Review from there.",
    links: [APPT],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["how to resubmit my request?", "needs revision what to do?"],
  },
  {
    id: "pickup-request",
    domain: "T-5",
    intent: "pickup_request",
    needs: ["pickup"],
    wants: ["pickup", "request", "authentication", "excuse", "ready", "schedule", "claim", "requirements", "id"],
    phrases: ["ready for pickup", "pickup scheduled"],
    reply:
      "About request pickup:\n" +
      "1. When your Authentication or Excuse Slip request is Ready for Pickup, the SSO schedules the pickup.\n" +
      "2. Check the pickup date, time, and note on your request.\n" +
      "3. Bring a valid ID (and supporting documents for excuse slips) when you claim.",
    links: [APPT],
    followAsk: { label: "Check my request", prompt: "What's the status of my request?" },
    ticketPill: false,
    examples: ["when can I claim my documents?", "pickup schedule for my request?"],
  },
  // ── T-6 ID application ───────────────────────────────────────
  {
    id: "id-new-requirements",
    domain: "T-6",
    intent: "id_new_requirements",
    needs: ["id"],
    wants: ["id", "requirements", "new", "newid", "bring", "need", "file", "apply", "claim"],
    phrases: ["what to bring", "what do i need", "requirements"],
    reply:
      "To apply for a New ID:\n" +
      "1. Open ID Application and choose New.\n" +
      "2. Upload your OR receipt and enter the details asked.\n" +
      "3. Track it: Pending → OR Verified → Approved → Processing → Ready for Claiming.\n" +
      "4. Bring one valid ID and your QR code/reference number when claiming. No payment is required.",
    links: [IDAPP],
    followAsk: { label: "What to bring", prompt: "What do I need to bring when claiming my ID?" },
    ticketPill: false,
    examples: ["what do I need for a new ID?", "ano kailangan sa new id?", "what to bring when claiming my ID?"],
  },
  {
    id: "id-lost-requirements",
    domain: "T-6",
    intent: "id_lost_requirements",
    needs: ["lostid"],
    wants: ["lostid", "requirements", "affidavit", "bring", "need", "file", "apply", "claim", "id"],
    phrases: ["affidavit of loss", "lost id"],
    reply:
      "To apply for a Lost ID replacement (no payment required):\n" +
      "1. Open ID Application and choose Lost.\n" +
      "2. Upload your OR receipt and your signed Affidavit of Loss.\n" +
      "3. Track it: Pending → OR Verified → Approved → Processing → Ready for Claiming.\n" +
      "4. Bring one valid ID and your QR code/reference number when claiming. You can get the affidavit template from Downloadable Forms.",
    links: [IDAPP],
    followAsk: { label: "What to bring", prompt: "What do I need to bring when claiming my ID?" },
    ticketPill: false,
    examples: ["ano kailangan sa lost id?", "affidavit of loss saan?", "lost id requirements"],
  },
  {
    id: "id-track-pickup",
    domain: "T-6",
    intent: "id_track_pickup",
    needs: ["id", "pickup"],
    wants: ["id", "pickup", "status", "ready", "claim", "schedule", "track"],
    phrases: ["ready for claiming", "pickup"],
    reply:
      "To track your ID application:\n" +
      "1. Open ID Application and find your request by its IDA- code.\n" +
      "2. Follow Pending → OR Verified → Approved → Processing → Ready for Claiming.\n" +
      "3. When it's ready, the SSO sets your pickup date and time — bring one valid ID and your QR code/reference number.",
    links: [IDAPP],
    followAsk: { label: "What to bring", prompt: "What do I need to bring when claiming my ID?" },
    ticketPill: false,
    examples: ["is my ID ready for claiming?", "when can I pick up my ID?"],
  },
  // ── T-7 events ───────────────────────────────────────────────
  {
    id: "event-who-can-file",
    domain: "T-7",
    intent: "event_who_can_file",
    needs: ["event"],
    wants: ["event", "representative", "organization", "file", "who", "org", "adviser", "member"],
    phrases: ["who can", "sino pwede", "sino ang", "org rep", "representative"],
    reply:
      "About filing an event request:\n" +
      "1. Only an active organization representative may file — ask your org head or the SSO if you're unsure who yours is.\n" +
      "2. Attach your adviser's endorsement to the request.\n" +
      "3. Track review under Event Requests. Booking a consultation visit is optional.",
    links: [BULLETIN, REQUESTS],
    followAsk: { label: "Filing lead time", prompt: "How early should our org file an event request?" },
    ticketPill: false,
    examples: ["sino pwede mag file ng event?", "who can file an event request for our organization?"],
  },
  {
    id: "event-lead-time",
    domain: "T-7",
    intent: "event_lead_time",
    needs: ["event"],
    wants: ["event", "early", "day", "before", "deadline", "lead", "week", "file"],
    phrases: ["how early", "working days", "days before", "lead time"],
    reply:
      "File event requests at least 10 working days before the event date, with your adviser's endorsement attached.\n\n" +
      "Late filings may not clear review in time — file early and track the status under Event Requests.",
    links: [BULLETIN],
    followAsk: { label: "Who can file", prompt: "Who can file an event request for our organization?" },
    ticketPill: false,
    examples: ["how early file event?", "how early should our org file an event request?"],
  },
  // ── T-8 / T-9 confidential ───────────────────────────────────
  {
    id: "referral-guidance",
    domain: "T-8",
    intent: "referral_guidance",
    needs: ["referral"],
    wants: ["referral", "talk", "seek", "someone", "file", "help", "counsel", "appointment", "psych", "guidance", "how"],
    phrases: ["psychological", "mental health", "counsel"],
    reply:
      "If you need someone to talk to, the SSO offers confidential Psychological Intervention visits (45-minute slots):\n" +
      "1. File a referral or book a Psychological Intervention visit under Appointments.\n" +
      "2. Only you and authorized SSO staff can see the details.\n\n" +
      "I can't show referral details here. For urgent concerns, please visit the SSO office directly.",
    links: [REQUESTS],
    followAsk: null,
    ticketPill: true,
    examples: ["how to seek counseling?", "psychological intervention help", "I need someone to talk to referral"],
  },
  {
    id: "complaint-guidance",
    domain: "T-9",
    intent: "complaint_guidance",
    needs: ["complaint"],
    wants: ["complaint", "file", "how", "report", "facilities", "confidential", "status"],
    phrases: ["file a complaint", "complaint"],
    reply:
      "To raise a complaint:\n" +
      "1. File it through the Complaints module with the category and details.\n" +
      "2. Choose Standard or Confidential handling.\n" +
      "3. SSO staff review it — follow-ups come through official channels.\n\n" +
      "I can't show complaint details here. For anything I can't resolve, a support ticket also reaches the right office.",
    links: [HELPDESK],
    followAsk: null,
    ticketPill: true,
    examples: ["how to file a complaint?", "my complaint status", "reklamo saan mag file?"],
  },
  // ── T-10 tickets ─────────────────────────────────────────────
  {
    id: "ticket-create",
    domain: "T-10",
    intent: "ticket_create",
    needs: ["ticket"],
    wants: ["ticket", "create", "file", "new", "open", "submit", "how", "help"],
    phrases: ["create a ticket", "new ticket", "file a ticket"],
    reply:
      "To create a support ticket:\n" +
      "1. Open Help Desk and choose + New ticket (or use the ticket suggestion in this chat).\n" +
      "2. Pick a category, write a subject, and describe the issue.\n" +
      "3. Submit — staff reply in the ticket thread (Open → Answered → Closed). Closing is done by staff once resolved.",
    links: [HELPDESK],
    followAsk: null,
    ticketPill: true,
    examples: ["how do I create a ticket?", "paano mag file ng ticket?", "new ticket please"],
  },
  // ── T-11 bulletins ───────────────────────────────────────────
  {
    id: "bulletin-info",
    domain: "T-11",
    intent: "bulletin_info",
    needs: ["bulletin"],
    wants: ["bulletin", "view", "event", "announcement", "notice", "post", "update", "where"],
    phrases: ["student bulletin", "bulletin"],
    reply:
      "Announcements and event reminders are posted on the Student Bulletin:\n" +
      "1. Open the Student Bulletin to browse published notices.\n" +
      "2. Featured posts highlight the most urgent updates.\n\n" +
      "Draft (unpublished) notices aren't visible to students.",
    links: [BULLETIN],
    followAsk: null,
    ticketPill: false,
    examples: ["where are announcements posted?", "student bulletin updates"],
  },
  // ── T-12 forms ───────────────────────────────────────────────
  {
    id: "forms-info",
    domain: "T-12",
    intent: "forms_info",
    needs: ["form"],
    wants: ["form", "affidavit", "download", "upload", "template", "checklist", "where", "or"],
    phrases: ["downloadable forms", "affidavit template", "forms"],
    reply:
      "To get official templates:\n" +
      "1. Open Forms & Downloads and find what you need — e.g. the Affidavit of Loss template or the Event Clearance Checklist.\n" +
      "2. Download it, fill it out, and upload the signed copy where asked (OR receipt and affidavit go in the ID Application module).",
    links: [FORMS],
    followAsk: null,
    ticketPill: false,
    examples: ["saan makukuha form ng affidavit?", "where to download affidavit template?", "event clearance checklist form"],
  },
  // ── T-13 account ─────────────────────────────────────────────
  {
    id: "account-register",
    domain: "T-13",
    intent: "account_register",
    needs: ["register"],
    wants: ["account", "student", "masterlist", "approval", "sign", "enroll"],
    phrases: ["create account", "register"],
    reply:
      "To register an account:\n" +
      "1. Register with your student number — it must match the masterlist.\n" +
      "2. Wait for admin approval before signing in.\n" +
      "3. If your number isn't recognized, ask the SSO to check the masterlist entry.",
    links: [],
    followAsk: null,
    ticketPill: true,
    examples: ["how to register?", "paano mag register?", "create account steps"],
  },
  {
    id: "account-reset",
    domain: "T-13",
    intent: "account_reset",
    needs: ["password"],
    wants: ["reset", "forgot", "login", "email", "change", "recover"],
    phrases: ["forgot password", "reset password"],
    reply:
      "To reset your password:\n" +
      "1. Use Forgot Password on the sign-in page and enter your email.\n" +
      "2. Open the reset link sent to your email and set a new password.\n" +
      "3. If the link expired, request a new one. For anything else account-related, a support ticket reaches the right office.",
    links: [],
    followAsk: null,
    ticketPill: true,
    examples: ["forgot password?", "paano mag reset ng password?"],
  },
  {
    id: "account-approval",
    domain: "T-13",
    intent: "account_approval",
    needs: ["approval"],
    wants: ["account", "login", "register", "wait", "pending", "verify"],
    phrases: ["awaiting approval", "waiting for approval"],
    reply:
      "New accounts need admin approval before sign-in works:\n" +
      "1. After registering, wait for the \"Awaiting admin approval\" state to clear.\n" +
      "2. If it's been a while, follow up via a support ticket so staff can check your masterlist entry.",
    links: [],
    followAsk: null,
    ticketPill: true,
    examples: ["waiting for approval?", "account pending approval"],
  },
  {
    id: "account-profile",
    domain: "T-13",
    intent: "account_profile",
    needs: ["profile"],
    wants: ["change", "update", "edit", "email", "course", "year", "verify"],
    phrases: ["profile change", "update profile"],
    reply:
      "To update your profile (name, email, course, year):\n" +
      "1. Submit a profile change from your account page.\n" +
      "2. It goes through staff verification before it takes effect.\n" +
      "3. You'll be notified once it's approved.",
    links: [],
    followAsk: null,
    ticketPill: true,
    examples: ["how to change my profile?", "update my email address"],
  },
  // ── T-14 organizations ───────────────────────────────────────
  {
    id: "org-rep-info",
    domain: "T-14",
    intent: "org_rep_info",
    needs: ["representative"],
    wants: ["organization", "event", "become", "who", "org", "assign", "member"],
    phrases: ["organization representative", "org rep", "become"],
    reply:
      "About organization representatives:\n" +
      "1. Each active organization has representatives assigned by SSO staff (assignments can expire).\n" +
      "2. Only an active representative may file event requests for the org.\n" +
      "3. Ask your org head or the SSO if you need to know — or become — your org's representative.",
    links: [],
    followAsk: null,
    ticketPill: true,
    examples: ["who is our org rep?", "how to become organization representative?"],
  },
  // ── T-15 office info ─────────────────────────────────────────
  {
    id: "office-hours",
    domain: "T-15",
    intent: "office_hours",
    needs: ["hours"],
    wants: ["hours", "office", "open", "close", "appointment", "visit", "sso", "when"],
    phrases: ["office hours", "what time", "are you open"],
    reply:
      "SSO office hours: Monday–Friday, 8:00 AM – 5:00 PM (no noon break).\n\n" +
      "Book visits only on weekdays within the current or next month. The office is closed on declared holidays — those dates show as unavailable on the Appointments calendar.",
    links: [APPT],
    followAsk: { label: "How to book", prompt: "Where do I book an appointment?" },
    ticketPill: false,
    examples: ["what are the SSO office hours?", "bukas ba ang SSO bukas?", "are you open tomorrow?"],
  },
];

export type RuleHit = {
  rule: TxRule;
  analysis: WordAnalysis;
  score: number;
};

function ruleFires(rule: TxRule, a: WordAnalysis): { fires: boolean; score: number } {
  for (const need of rule.needs) {
    if (!a.tokenSet.has(need)) return { fires: false, score: 0 };
  }
  const wantsHit = rule.wants.filter((w) => a.tokenSet.has(w)).length;
  const phraseHit = rule.phrases.some((p) => a.stripped.includes(p));
  if (rule.wants.length === 0 && rule.phrases.length === 0) {
    return { fires: true, score: 2 * rule.needs.length };
  }
  if (wantsHit === 0 && !phraseHit) return { fires: false, score: 0 };
  return {
    fires: true,
    score: 2 * rule.needs.length + wantsHit + (phraseHit ? 2 : 0) + (a.refs.length ? 1 : 0),
  };
}

/**
 * Match the best transaction rule. Small-talk is checked first via the
 * starter layer (exact + TL/typo tolerant); guide phrases strip to the
 * remainder and re-match so "walk me through X" reaches the same rule as
 * "how do I X". Returns null when nothing fires.
 */
export function matchTxRule(raw: string): RuleHit | null {
  const starter = matchStarterIntent(raw);
  if (starter === "greeting" || starter === "thanks" || starter === "farewell" || starter === "capabilities") {
    return null; // handled by the small-talk reply path (same voice, no draft)
  }
  let message = raw;
  let guided = false;
  if (starter === "guide") {
    const a0 = analyzeMessage(raw);
    // Strip guide phrases; empty remainder → capabilities nudge.
    let rest = a0.stripped;
    for (const g of ["walk me through", "guide me", "step by step", "step-by-step", "guide"]) {
      rest = rest.replace(g, " ").trim();
    }
    rest = rest.replace(/\s+/g, " ").trim();
    if (!rest) return { rule: GUIDE_RULE, analysis: a0, score: 99 };
    message = rest;
    guided = true;
  }
  const a = analyzeMessage(message);
  // Confidential / billing / TOR never reach generic rules — the route
  // handles them on dedicated safety rails first.
  let best: RuleHit | null = null;
  for (const rule of TX_RULES) {
    const { fires, score } = ruleFires(rule, a);
    if (!fires) continue;
    // Rank by score; ties break by lowest rule id (deterministic, spec §6.2).
    // Filing guidance ("file-*", "id-new-*") sorts before "request-only-*",
    // so bare mentions ("authentication", "id") get how-to steps while
    // booking signals ("walk in", "directly") still outscore them.
    if (!best || score > best.score || (score === best.score && rule.id < best.rule.id)) {
      best = { rule, analysis: a, score };
    }
  }
  if (best && guided) best = { ...best, score: best.score + 0.5 };
  return best;
}

const GUIDE_RULE: TxRule = {
  id: "guide-nudge",
  domain: "T-17",
  intent: "guide",
  needs: [],
  wants: [],
  phrases: [],
  reply: GUIDE_NUDGE,
  links: [],
  followAsk: null,
  ticketPill: false,
  examples: ["guide me", "walk me through"],
};

export function getGuideNudge(): TxRule {
  return GUIDE_RULE;
}
