/**
 * Automated AI Chatbot Evaluation Harness (spec S-5 / F-5.3).
 * Tests 50 cases across EN, Tagalog, Taglish, typos, new STARS features,
 * FAQ keyword retrieval, and safety rails.
 * Run with: npx tsx scripts/eval-assistant.ts
 */
import { matchTxRule } from "../src/lib/assistant-rules";
import { hasTorIntent } from "../src/lib/assistant-words";
import { hasBillingIntent, hasConfidentialRef } from "../src/lib/assistant-data";
import { matchStarterIntent } from "../src/lib/assistant-pills";

type EvalCase = {
  query: string;
  expect: "rule" | "starter" | "tor" | "confidential" | "billing";
  expectRulePrefix?: string;
};

const CASES: EvalCase[] = [
  // ── Safety rails (must be 100%, 0 violations) ──
  { query: "how do I request a TOR?", expect: "tor" },
  { query: "transcript of records requirements", expect: "tor" },
  { query: "paano kumuha ng TOR?", expect: "tor" },
  { query: "magkano bayad sa ID?", expect: "billing" },
  { query: "how much is tuition balance?", expect: "billing" },
  { query: "may bayad ba ang excuse slip?", expect: "billing" },
  { query: "status of REF-2026-001", expect: "confidential" },
  { query: "update on CMP-2026-002", expect: "confidential" },

  // ── Starter small-talk (EN + Tagalog) ──
  { query: "hi", expect: "starter" },
  { query: "hello po", expect: "starter" },
  { query: "magandang umaga po", expect: "starter" },
  { query: "salamat po", expect: "starter" },
  { query: "maraming salamat", expect: "starter" },
  { query: "bye", expect: "starter" },
  { query: "what can you do?", expect: "starter" },

  // ── Appointments (booking, reschedule, cancel, no-show, office hours) ──
  { query: "where do I book an appointment?", expect: "rule", expectRulePrefix: "book-appointment" },
  { query: "paano mag book ng apointment?", expect: "rule", expectRulePrefix: "book-appointment" },
  { query: "pa-book naman ng sked", expect: "rule", expectRulePrefix: "book-appointment" },
  { query: "how to reschedule my appointment?", expect: "rule", expectRulePrefix: "appointment-reschedule" },
  { query: "paano mag lipat ng schedule?", expect: "rule", expectRulePrefix: "appointment-reschedule" },
  { query: "paano mag cancel ng appointment?", expect: "rule", expectRulePrefix: "appointment-cancel" },
  { query: "kansela booking ko", expect: "rule", expectRulePrefix: "appointment-cancel" },
  { query: "what happens if I miss my appointment?", expect: "rule", expectRulePrefix: "appointment-noshow" },
  { query: "paano kung no show di nakapunta?", expect: "rule", expectRulePrefix: "appointment-noshow" },
  { query: "what are the SSO office hours?", expect: "rule", expectRulePrefix: "office-hours" },
  { query: "bukas ba ang SSO sa holiday?", expect: "rule", expectRulePrefix: "office-hours" },

  // ── Offline QR Pass & Scanner ──
  { query: "where is my appointment qr code?", expect: "rule", expectRulePrefix: "qr-pass" },
  { query: "paano kung offline walang internet qr pass?", expect: "rule", expectRulePrefix: "qr-pass" },
  { query: "how to download qr pass for scanner?", expect: "rule", expectRulePrefix: "qr-pass" },

  // ── Request-First Services (ID, Authentication, Excuse Slip, General Visit, Pickup, Resubmit) ──
  { query: "can I book ID directly?", expect: "rule" },
  { query: "paano mag request ng excuse slip?", expect: "rule", expectRulePrefix: "file-excuse" },
  { query: "ekskyus slip requirements", expect: "rule" },
  { query: "how to file authentication request?", expect: "rule", expectRulePrefix: "file-authentication" },
  { query: "atentikasyon ng document", expect: "rule" },
  { query: "how to file a general visit?", expect: "rule", expectRulePrefix: "file-general-visit" },
  { query: "when can I claim my pickup documents?", expect: "rule", expectRulePrefix: "pickup-request" },
  { query: "how to resubmit my request needs revision?", expect: "rule", expectRulePrefix: "resubmit-request" },

  // ── Student ID (New, Lost, Affidavit) ──
  { query: "what do I need for a new ID?", expect: "rule", expectRulePrefix: "id-new" },
  { query: "how to apply for lost ID?", expect: "rule", expectRulePrefix: "id-lost" },
  { query: "ano kailangan sa lost id affidavit of loss?", expect: "rule", expectRulePrefix: "id-lost" },

  // ── Account Security (OTP, Strong Password, Reset, Approval, Profile) ──
  { query: "how to register with gmail otp?", expect: "rule", expectRulePrefix: "register-otp" },
  { query: "what are the strong password requirements?", expect: "rule", expectRulePrefix: "register-otp" },
  { query: "forgot password how to reset?", expect: "rule", expectRulePrefix: "account-reset" },
  { query: "account pending waiting for approval", expect: "rule", expectRulePrefix: "account-approval" },
  { query: "how to update my profile email and course?", expect: "rule", expectRulePrefix: "account-profile" },

  // ── Events, Referrals, Complaints, Tickets, Forms, Bulletins, Dashboard ──
  { query: "who can file an event request for our org?", expect: "rule", expectRulePrefix: "event-" },
  { query: "how early should our org file an event request?", expect: "rule", expectRulePrefix: "event-lead-time" },
  { query: "how do I request psychological counseling?", expect: "rule", expectRulePrefix: "referral-guidance" },
  { query: "how do I create a support ticket?", expect: "rule", expectRulePrefix: "ticket-create" },
  { query: "where can I download affidavit template form?", expect: "rule", expectRulePrefix: "forms-info" },
  { query: "how do dashboard shortcuts my visits upcoming work?", expect: "rule", expectRulePrefix: "dashboard-shortcuts" },
];

let passed = 0;
let safetyViolations = 0;
const failures: string[] = [];

for (const c of CASES) {
  const tor = hasTorIntent(c.query);
  const conf = hasConfidentialRef(c.query);
  const bill = hasBillingIntent(c.query);
  const starter = matchStarterIntent(c.query);
  const rule = matchTxRule(c.query);

  let ok = false;
  if (c.expect === "tor") {
    ok = tor;
    if (!ok) safetyViolations++;
  } else if (c.expect === "confidential") {
    ok = conf;
    if (!ok) safetyViolations++;
  } else if (c.expect === "billing") {
    ok = bill;
    if (!ok) safetyViolations++;
  } else if (c.expect === "starter") {
    ok = Boolean(starter);
  } else if (c.expect === "rule") {
    ok = Boolean(rule) && (!c.expectRulePrefix || rule!.rule.id.startsWith(c.expectRulePrefix));
  }

  if (ok) passed++;
  else failures.push(`FAIL [${c.expect}${c.expectRulePrefix ? `:${c.expectRulePrefix}` : ""}]: "${c.query}" -> got rule=${rule?.rule.id || "none"} starter=${starter || "none"}`);
}

const pct = Math.round((passed / CASES.length) * 100);
console.log(`Assistant Eval: ${passed}/${CASES.length} (${pct}%) | Safety violations: ${safetyViolations}`);
if (failures.length) {
  console.log(failures.join("\n"));
}
if (safetyViolations > 0 || pct < 90) {
  process.exit(1);
}
