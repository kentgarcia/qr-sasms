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

const DASHBOARD = { label: "Open Dashboard", target: "page-student" } as RuleLink;
const APPT = { label: "My Appointments", target: "page-appointment" } as RuleLink;
const IDAPP = { label: "Open ID Application", target: "page-idapp" } as RuleLink;
const BULLETIN = { label: "Student Bulletin", target: "page-bulletin" } as RuleLink;
const REQUESTS = { label: "Book / Request", target: "page-appointment-book" } as RuleLink;
const HELPDESK = { label: "Open Help Desk", target: "page-helpdesk" } as RuleLink;
const FORMS = { label: "Forms", target: "page-forms" } as RuleLink;
const ACCOUNT = { label: "My Profile", target: "page-account" } as RuleLink;
const REFERRAL = { label: "Open Referrals", target: "page-referral" } as RuleLink;
const COMPLAINT = { label: "Open Complaints", target: "page-complaint" } as RuleLink;

export const CONFIDENTIAL_REDIRECT_REPLY =
  "For your privacy, I can't view or display Referral or Complaint details here — those records are confidential and restricted to authorized PUP San Pedro SSO staff.\n\n" +
  "• For urgent personal or counseling concerns, please visit the SSO office directly.\n" +
  "• For non-confidential follow-ups, tap **Create Support Ticket** below so staff can assist you.";

export const BILLING_RULE_REPLY =
  "I don't have access to tuition, billing, or payment records, so I can't check balances directly.\n\n" +
  "Good to know: **SSO ID applications (New & Lost), Authentication, and Excuse Slips require no payment.** Tap **Create Support Ticket** below if you need billing or cashier assistance.";

export const GUIDE_NUDGE =
  "Sure — tell me which PUP San Pedro SSO transaction you need, and I'll walk you through it step by step!\n\n" +
  "Try asking:\n" +
  "• \"Walk me through requesting an excuse slip\"\n" +
  "• \"Guide me on applying for a lost ID\"\n" +
  "• \"How do I download my offline QR pass?\"";

// Rank order: score first, lowest rule id breaks ties (deterministic).
export const TX_RULES: TxRule[] = [
  // ── T-1 booking ──────────────────────────────────────────────
  {
    id: "book-appointment",
    domain: "T-1",
    intent: "book_appointment",
    needs: ["appointment"],
    wants: ["appointment", "book", "schedule", "slot", "date", "time", "walkin", "generalvisit", "event", "referral", "hours", "tomorrow", "today", "week"],
    phrases: ["book an appointment", "schedule a visit", "schedule visit", "pa-book", "pabook", "walk in", "walk-in"],
    reply:
      "**How to schedule a visit:**\n" +
      "1. Open **Schedule a Visit** and choose **General Visit**, **Event Consultation**, or **Psychological Intervention** (*ID, Authentication, and Excuse Slip are request-first*).\n" +
      "2. Pick an open weekday (Monday–Friday, current or next month) and an available time slot.\n" +
      "3. Submit — bookings start as **Pending Approval**. Once SSO staff approve, status becomes **Confirmed** and you receive an email with your `APT-###` code and **offline QR pass**.\n\n" +
      "Good to know: Limit of 1 active booking per student per date. Office hours: Mon–Fri, 8:00 AM – 5:00 PM (PHT, closed on holidays).",
    links: [REQUESTS, APPT],
    followAsk: { label: "Offline QR Pass", prompt: "How do I get my offline appointment QR pass?" },
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
      "**How to reschedule your appointment:**\n" +
      "1. Open **My Appointments** and click **Reschedule** on your active booking (or tap the **Reschedule** button below if you have one).\n" +
      "2. Pick a new available weekday and time slot.\n" +
      "3. Confirm — your `APT-###` code stays the same and your linked transaction updates automatically.\n\n" +
      "Good to know: Up to **2 reschedules** per appointment and a **24-hour cutoff** before the original slot apply.",
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
      "**How to cancel your appointment:**\n" +
      "1. Open **My Appointments** and click **Cancel** on your upcoming booking.\n" +
      "2. Enter a brief reason if prompted, then confirm.\n\n" +
      "Good to know: A **24-hour cutoff** applies before the scheduled slot. Cancelled `APT-###` codes are never reused — simply book a fresh slot whenever you're ready.",
    links: [APPT, REQUESTS],
    followAsk: { label: "Schedule a visit", prompt: "Where do I book an appointment?" },
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
      "**Student ID lanes are request-first** (no direct walk-in booking):\n" +
      "1. Open **ID Application** and submit a **New** or **Lost** ID request (upload OR receipt + signed Affidavit of Loss for lost IDs).\n" +
      "2. Track progress: `Pending → OR Verified → Approved → Processing → Ready for Claiming`.\n" +
      "3. Once ready, SSO staff schedule your pickup and generate an `APT-###` **offline QR pass** — **no payment is required**.",
    links: [IDAPP, FORMS],
    followAsk: { label: "What to bring", prompt: "What do I need to bring when claiming my ID?" },
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
      "**Authentication is a request-first service** (no direct slot booking):\n" +
      "1. Open **Schedule a Visit** and choose **Authentication**.\n" +
      "2. Enter your purpose, number of copies, and supporting details, then submit.\n" +
      "3. Track progress: `Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed`.\n" +
      "4. When ready, SSO schedules your pickup with an `APT-###` **offline QR pass**.",
    links: [REQUESTS, APPT],
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
      "**Excuse Slip is a request-first service** (no direct slot booking):\n" +
      "1. Open **Schedule a Visit** and choose **Excuse Slip**.\n" +
      "2. Enter your purpose, number of copies, and attach supporting documents (e.g. medical certificate).\n" +
      "3. Track progress: `Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed`.\n" +
      "4. Once ready, SSO schedules your pickup with an `APT-###` **offline QR pass**.",
    links: [REQUESTS, APPT],
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
      "**How to request Document Authentication:**\n" +
      "1. Open **Schedule a Visit** and select **Authentication**.\n" +
      "2. Enter your purpose and number of copies, then submit.\n" +
      "3. Track it under **My Appointments**: `Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed`.\n" +
      "4. Once ready, the SSO schedules your pickup and emails your `APT-###` **offline QR pass**.",
    links: [REQUESTS, APPT],
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
      "**How to request an Excuse Slip:**\n" +
      "1. Open **Schedule a Visit** and select **Excuse Slip**.\n" +
      "2. Enter your reason/purpose, number of copies, and upload supporting proof (e.g. medical certificate).\n" +
      "3. Track it under **My Appointments**: `Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed`.\n" +
      "4. Bring your supporting documents and **offline QR pass** when claiming at the SSO.",
    links: [REQUESTS, APPT],
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
      "**How to file a General Visit:**\n" +
      "1. Open **Schedule a Visit** and choose **General Visit**.\n" +
      "2. Enter your purpose and select an available weekday and time slot.\n" +
      "3. Track approval under **My Appointments** — once confirmed, your `APT-###` **offline QR pass** appears in your dashboard and confirmation email.",
    links: [REQUESTS, APPT],
    followAsk: { label: "Offline QR Pass", prompt: "How do I get my offline appointment QR pass?" },
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
      "1. When your Authentication, Excuse Slip, or ID Application is ready, SSO staff schedule your pickup and automatically create a synced APT-### appointment with an offline QR pass.\n" +
      "2. Check your pickup date, time, and QR pass under My Appointments → Upcoming (or in your pickup notification email).\n" +
      "3. Present your QR pass and valid ID at the SSO Service Desk — scanning and serving completes both the appointment and your linked request.",
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
      "**How to apply for a New Student ID (no payment required):**\n" +
      "1. Open **ID Application** and choose **New**.\n" +
      "2. Upload your Official Receipt (OR) and enter the required details.\n" +
      "3. Track it: `Pending → OR Verified → Approved → Processing → Ready for Claiming`.\n" +
      "4. When ready, SSO schedules your pickup with an `APT-###` **offline QR pass**. Bring 1 valid ID when claiming.",
    links: [IDAPP, APPT],
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
      "**How to apply for a Lost ID replacement (no payment required):**\n" +
      "1. Download the **Affidavit of Loss** template from **Forms** and have it signed.\n" +
      "2. Open **ID Application**, choose **Lost**, and upload your OR receipt + signed Affidavit of Loss.\n" +
      "3. Track it: `Pending → OR Verified → Approved → Processing → Ready for Claiming`.\n" +
      "4. When ready, SSO schedules your pickup with an `APT-###` **offline QR pass**. Bring 1 valid ID when claiming.",
    links: [IDAPP, FORMS],
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
      "**How to track your ID Application & Pickup:**\n" +
      "1. Open **ID Application** or **My Appointments → Upcoming** (or paste your `IDA-` code right here in chat).\n" +
      "2. Follow `Pending → OR Verified → Approved → Processing → Ready for Claiming`.\n" +
      "3. Once ready, SSO schedules your pickup and sends your `APT-###` **offline QR pass** by email — bring 1 valid ID when claiming.",
    links: [IDAPP, APPT],
    followAsk: { label: "Check my ID status", prompt: "What's the status of my ID application?" },
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
      "**Need someone to talk to?** The PUP San Pedro SSO offers confidential **Psychological Intervention** sessions (45-minute slots):\n" +
      "1. Submit a referral under **Referrals** or book a **Psychological Intervention** slot under **Book / Request**.\n" +
      "2. Your details stay strictly private — only you and authorized SSO admins can view them (scanner desks show **Reserved — Confidential**).\n\n" +
      "For privacy, I never read referral details here. For urgent concerns, please visit the SSO office directly.",
    links: [REFERRAL, REQUESTS],
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
      "**How to file a student complaint:**\n" +
      "1. Open **Complaints**, choose a category, and describe your concern (attach evidence if available).\n" +
      "2. Select **Standard** or **Confidential** handling.\n" +
      "3. SSO staff review it and follow up through official channels.\n\n" +
      "For privacy, I can't view complaint details here. You can also open a Help Desk support ticket for general issues.",
    links: [COMPLAINT, HELPDESK],
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
      "1. Open Forms and find what you need — e.g. the Affidavit of Loss template or the Event Clearance Checklist.\n" +
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
      "To register a STARS student account:\n" +
      "1. Click Register here and enter your details + official PUP San Pedro Student Number (must exist in the SSO masterlist).\n" +
      "2. Enter your Gmail or PUP email address and click Send OTP to receive a 6-digit verification code (valid for 10 minutes).\n" +
      "3. Create a strong password (more than 8 characters / 9+, with uppercase, lowercase, a number, and a special character) and confirm it.\n" +
      "4. Submit and wait for SSO Admin approval before signing in.",
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
      "**How to reset or change your password:**\n" +
      "1. **Signed out:** Click **Forgot Password** on the sign-in page, enter your email, and open the reset link sent to you.\n" +
      "2. **Signed in:** Open **My Profile → Change Password**.\n" +
      "3. Your new password must be **more than 8 characters (9+)** with uppercase, lowercase, a number, and a special character (e.g. `!@#$%`).",
    links: [ACCOUNT],
    followAsk: { label: "Password requirements", prompt: "What are the strong password requirements?" },
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
      "**Account Approval Status:**\n" +
      "1. New student accounts require **SSO Admin approval** after OTP verification before sign-in works.\n" +
      "2. You will receive an email once your account is approved.\n" +
      "3. If it's been waiting a while, open a Help Desk support ticket so staff can check your masterlist entry.",
    links: [HELPDESK],
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
      "**How to update your profile (name, email, course, year):**\n" +
      "1. Open **My Profile** and submit a **Profile Change** request.\n" +
      "2. SSO staff verify the update before it takes effect.\n" +
      "3. You'll receive an in-app notification once it is approved.",
    links: [ACCOUNT],
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
  {
    id: "qr-pass-offline",
    domain: "T-4",
    intent: "appointment_qr",
    needs: ["qr"],
    wants: ["appointment", "offline", "scan", "pass", "pickup", "download", "print", "checkin", "qr"],
    phrases: ["qr code", "qr pass", "no internet", "walang internet", "cannot open link", "offline"],
    reply:
      "Every confirmed appointment and scheduled pickup includes a signed, offline-ready QR pass:\n" +
      "1. Open My Appointments (or click the Next Appointment shortcut on your Dashboard) and click View.\n" +
      "2. Download the QR pass as a PNG or Print Pass before going to campus — it is also embedded directly in your confirmation and pickup emails.\n" +
      "3. Present it at the SSO Service Desk — staff can scan it even when the portal link cannot be accessed.",
    links: [APPT],
    followAsk: { label: "View my appointments", prompt: "What is the status of my appointment?" },
    ticketPill: false,
    examples: ["where is my appointment qr code?", "paano kung offline walang internet qr pass?", "how to download qr pass for scanner"],
  },
  {
    id: "register-otp-password",
    domain: "T-13",
    intent: "account_security",
    needs: [],
    wants: ["register", "otp", "password", "email"],
    phrases: ["send otp", "email otp", "gmail otp", "verification code", "strong password", "create account"],
    reply:
      "To create a STARS student account:\n" +
      "1. Enter your details and enrolled Student Number (must be in the PUP San Pedro masterlist).\n" +
      "2. Enter your Gmail or PUP email address and click Send OTP to receive a 6-digit verification code (valid for 10 minutes).\n" +
      "3. Create a strong password with more than 8 characters (9+), including uppercase, lowercase, a number, and a special character (e.g. !@#$%).\n" +
      "4. Submit your registration and wait for SSO Admin approval before signing in.",
    links: [],
    followAsk: { label: "SSO office hours", prompt: "What are the SSO office hours?" },
    ticketPill: false,
    examples: ["how to register with gmail otp?", "what are the password requirements?", "paano makakuha ng otp verification code?"],
  },
  {
    id: "appointment-noshow",
    domain: "T-3",
    intent: "appointment_noshow",
    needs: ["noshow"],
    wants: ["noshow", "appointment", "pickup", "missed", "absent", "book", "reschedule"],
    phrases: ["no show", "no-show", "missed appointment", "di nakapunta", "hindi nakapunta"],
    reply:
      "If you miss your scheduled appointment (No Show):\n" +
      "1. Staff mark the visit as No Show, and it moves to read-only history under My Appointments.\n" +
      "2. For General Visits, Event Consultations, or Counseling, simply book a new available weekday slot.\n" +
      "3. For missed Authentication, Excuse Slip, or ID pickups, your request returns to Ready for Pickup so SSO staff can schedule a new pickup slot.",
    links: [APPT],
    followAsk: { label: "How to book", prompt: "Where do I book an appointment?" },
    ticketPill: false,
    examples: ["what happens if I miss my appointment?", "paano kung no show ako?", "hindi nakapunta sa appointment"],
  },
  {
    id: "dashboard-shortcuts",
    domain: "T-4",
    intent: "dashboard_shortcuts",
    needs: ["dashboard"],
    wants: ["dashboard", "shortcut", "upcoming", "served", "visit", "appointment", "transaction"],
    phrases: ["my visits", "next appointment", "dashboard shortcut"],
    reply:
      "**Your Dashboard KPI Cards work as one-tap shortcuts:**\n" +
      "• **My Visits** → opens all your appointments and linked transactions\n" +
      "• **Upcoming** → jumps directly to confirmed visits and scheduled pickups\n" +
      "• **Served** → opens your completed visit history\n" +
      "• **Next Appointment** → opens your upcoming appointment details and **offline QR pass** right away.",
    links: [DASHBOARD, APPT],
    followAsk: { label: "View my appointments", prompt: "What's the status of my appointments?" },
    ticketPill: false,
    examples: ["how do dashboard shortcuts work?", "where to see my visits and upcoming?"],
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
