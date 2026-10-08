// Rule-based chatbot — shared word recognition (docs/ai-assistant-rulebased-chatbot-spec.md §5).
//
// Single source of truth for normalization, tokenization, phrase scan,
// EN+TL synonyms, stop words, stemming, typo repair, and entity extraction.
// Used by transaction rules and the status/billing detectors. The FAQ keyword
// scorer in assistant.ts is intentionally unchanged (threshold parity).

export const WORD_STOP_WORDS = new Set([
  "about", "also", "and", "ang", "are", "ba", "can", "could", "does",
  "for", "from", "get", "how", "i", "is", "it", "ko", "mga", "need",
  "ng", "of", "on", "or", "please", "pwede", "sa", "the", "to",
  "what", "where", "when", "with", "you", "your",
  // Spec §5.3 additions (Filipino particles / question words).
  "po", "opo", "lang", "naman", "diba", "daw", "raw", "yung", "yong",
  "ito", "iyan", "iyon", "ano", "paano", "saan", "kailan", "sino",
  "bakit", "ilan", "meron", "mayroon", "gusto", "puede", "paki",
  "ako", "kami", "kayo", "siya", "sila", "namin", "natin", "atin",
  "akin", "iyo", "kanya", "kanila", "mong", "kong", "mo", "ni",
  "kay", "kina", "si", "ay", "eh", "oh", "ha", "hoy", "san",
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "will", "would", "can", "could", "should",
  "my", "me", "we", "our", "us", "he", "she", "they", "them",
  "this", "that", "these", "those", "am", "as", "at", "by", "in",
]);

// variant -> canonical (spec §5.3). Keys are post-normalization single tokens
// or compacted forms (hyphens/spaces removed where noted).
const SYNONYMS: Record<string, string> = {
  // appointments
  apointment: "appointment",
  appoinment: "appointment",
  appointmen: "appointment",
  booking: "appointment",
  booked: "appointment",
  bookings: "appointment",
  sched: "appointment",
  schedule: "appointment",
  schedules: "appointment",
  scheduling: "appointment",
  slot: "appointment",
  slots: "appointment",
  visit: "appointment",
  visits: "appointment",
  checkin: "appointment",
  pabook: "appointment",
  "pa-book": "appointment",
  magpa: "book",
  book: "book",
  books: "book",
  // authentication
  auth: "authentication",
  authenticated: "authentication",
  authentication: "authentication",
  cert: "authentication",
  certificate: "authentication",
  certificates: "authentication",
  certification: "authentication",
  patunay: "authentication",
  pagpapatunay: "authentication",
  // excuse
  excuse: "excuse",
  medcert: "excuse",
  // id
  identification: "id",
  umid: "id",
  lost: "lostid",
  loss: "lostid",
  // affidavit
  affidavit: "affidavit",
  pagkawala: "affidavit",
  // event
  activity: "event",
  activities: "event",
  program: "event",
  seminar: "event",
  workshop: "event",
  assembly: "event",
  // ticket
  helpdesk: "ticket",
  ticket: "ticket",
  tickets: "ticket",
  concern: "ticket",
  reklamo: "ticket",
  // status
  track: "status",
  tracking: "status",
  update: "status",
  updates: "status",
  kamusta: "status",
  kumusta: "status",
  nasaan: "status",
  asan: "status",
  // cancel / reschedule
  cancel: "cancel",
  cancelled: "cancel",
  cancellation: "cancel",
  kansela: "cancel",
  reschedule: "reschedule",
  rebook: "reschedule",
  lipat: "reschedule",
  palit: "reschedule",
  move: "reschedule",
  // pickup
  pickup: "pickup",
  claim: "pickup",
  claiming: "pickup",
  kuha: "pickup",
  kuhanin: "pickup",
  // requirements
  requirements: "requirements",
  requirement: "requirements",
  reqs: "requirements",
  kailangan: "requirements",
  dadalhin: "requirements",
  dalhin: "requirements",
  bring: "requirements",
  // hours
  hours: "hours",
  oras: "hours",
  bukas: "hours",
  sarado: "hours",
  // forms
  form: "form",
  forms: "form",
  template: "form",
  dokumento: "form",
  // help
  tulong: "help",
  assist: "help",
  assistance: "help",
  support: "help",
  // misc process words
  file: "file",
  filing: "file",
  apply: "file",
  request: "request",
  requests: "request",
  register: "register",
  login: "login",
  password: "password",
  reset: "reset",
  representative: "representative",
  representatives: "representative",
  rep: "representative",
  org: "organization",
  organization: "organization",
  bulletin: "bulletin",
  announcements: "bulletin",
  announcement: "bulletin",
  balance: "billing",
  tuition: "billing",
  payment: "billing",
  fee: "billing",
  fees: "billing",
  pay: "billing",
  bayad: "billing",
  magkano: "billing",
  referral: "referral",
  psych: "referral",
  counseling: "referral",
  counsel: "referral",
  counselor: "referral",
  guidance: "referral",
  psychologist: "referral",
  open: "hours",
  opened: "hours",
  close: "hours",
  closed: "hours",
  complaint: "complaint",
  tor: "tor",
};

// Multi-word phrases scanned longest-first; value is the canonical token
// injected into the token set (spec §5.1).
const PHRASES: Array<{ phrase: string; token: string }> = [
  { phrase: "affidavit of loss", token: "affidavit" },
  { phrase: "sinumpaang salaysay", token: "affidavit" },
  { phrase: "excuse slip", token: "excuse" },
  { phrase: "excuse letter", token: "excuse" },
  { phrase: "medical certificate", token: "excuse" },
  { phrase: "general visit", token: "generalvisit" },
  { phrase: "id application", token: "id" },
  { phrase: "school id", token: "id" },
  { phrase: "student id", token: "id" },
  { phrase: "lost id", token: "lostid" },
  { phrase: "new id", token: "newid" },
  { phrase: "support ticket", token: "ticket" },
  { phrase: "help desk", token: "ticket" },
  { phrase: "office hours", token: "hours" },
  { phrase: "transcript of records", token: "tor" },
  { phrase: "follow up", token: "status" },
  { phrase: "follow-up", token: "status" },
  { phrase: "pick up", token: "pickup" },
  { phrase: "pick-up", token: "pickup" },
  { phrase: "check in", token: "appointment" },
  { phrase: "check-in", token: "appointment" },
  { phrase: "walk in", token: "walkin" },
  { phrase: "walk-in", token: "walkin" },
  { phrase: "general assembly", token: "event" },
  { phrase: "org activity", token: "event" },
  { phrase: "mental health", token: "referral" },
  { phrase: "what can you do", token: "capabilities" },
  { phrase: "what do you do", token: "capabilities" },
  { phrase: "how can you help", token: "capabilities" },
  { phrase: "how do i use this", token: "capabilities" },
  { phrase: "walk me through", token: "guide" },
  { phrase: "step by step", token: "guide" },
  { phrase: "step-by-step", token: "guide" },
  { phrase: "guide me", token: "guide" },
  { phrase: "good morning", token: "greeting" },
  { phrase: "good afternoon", token: "greeting" },
  { phrase: "good evening", token: "greeting" },
  { phrase: "good night", token: "farewell" },
  { phrase: "goodnight", token: "farewell" },
  { phrase: "thank you", token: "thanks" },
  { phrase: "thank u", token: "thanks" },
  { phrase: "maraming salamat", token: "thanks" },
  { phrase: "magandang umaga", token: "greeting" },
  { phrase: "magandang hapon", token: "greeting" },
  { phrase: "magandang gabi", token: "greeting" },
  { phrase: "see you", token: "farewell" },
];

// Closed typo-repair allowlist (spec §5.5): canonical words only, len>=5,
// edit distance <=1. Never applied to short words, names, or ref codes.
const TYPO_ALLOWLIST = [
  "appointment", "authentication", "excuse", "request", "ticket",
  "status", "affidavit", "pickup", "schedule", "event", "referral",
  "complaint", "bulletin", "organization", "representative", "requirements",
  "cancel", "reschedule", "billing", "password", "register", "hours",
  "guide", "greeting", "thanks", "farewell", "capabilities", "generalvisit",
];

export function foldDiacritics(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/gi, "n");
}

export function normalizeMessage(raw: string): string {
  let s = foldDiacritics(String(raw || ""))
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[“”‘’«»]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  // Strip trailing sentence punctuation (repeat "?!" kept short).
  s = s.replace(/[!?.…]+$/g, "").trim();
  return s;
}

export function stemWord(word: string): string {
  let w = String(word || "");
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 6) {
    const base = w.slice(0, -3);
    if (base.length >= 3) return base;
  }
  if (w.endsWith("ed") && w.length > 5) {
    const base = w.slice(0, -2);
    if (base.length >= 3) return base;
  }
  if (w.endsWith("s") && w.length > 3 && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function editDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (la === lb) {
      i++;
      j++;
    } else if (la > lb) {
      i++;
    } else {
      j++;
    }
  }
  edits += la - i + (lb - j);
  return edits <= 1;
}

function transposeMatch(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 5) return false;
  for (let i = 0; i < a.length - 1; i++) {
    const swapped = a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2);
    if (swapped === b) return true;
  }
  return false;
}

/** Repair a single token against the closed allowlist; null when no repair. */
export function repairTypo(token: string): string | null {
  const t = String(token || "");
  if (t.length < 5) return null;
  if (TYPO_ALLOWLIST.includes(t)) return t;
  for (const c of TYPO_ALLOWLIST) {
    if (Math.abs(c.length - t.length) > 1 && c.length !== t.length) continue;
    if (editDistance1(t, c) || transposeMatch(t, c)) return c;
  }
  return null;
}

/** Fold one raw token to canonical (synonym → typo-repair → stem). */
export function canonicalizeToken(raw: string): string {
  let t = String(raw || "").toLowerCase();
  if (!t) return t;
  // Hyphenated compact forms (check-in, pick-up, pa-book …).
  if (SYNONYMS[t]) return SYNONYMS[t];
  const squashed = t.replace(/-/g, "");
  if (SYNONYMS[squashed]) return SYNONYMS[squashed];
  const repaired = repairTypo(t) || repairTypo(squashed);
  if (repaired) return SYNONYMS[repaired] || repaired;
  const stemmed = stemWord(t);
  if (SYNONYMS[stemmed]) return SYNONYMS[stemmed];
  return stemmed;
}

export type WordAnalysis = {
  normalized: string;
  stripped: string;
  wasStripped: boolean;
  tokens: string[];
  tokenSet: Set<string>;
  phrases: string[];
  refs: string[];
  confidentialRefs: string[];
  service: string | null;
  dateHint: boolean;
};

const GREETING_LEADS = [
  "hi", "hello", "hey", "kumusta", "kamusta",
  "magandang umaga", "magandang hapon", "magandang gabi",
  "good morning", "good afternoon", "good evening",
];

/** Greeting-prefix strip with word-boundary guard (spec §5.2). */
export function stripGreetingPrefix(normalized: string): { stripped: string; wasStripped: boolean } {
  const s = String(normalized || "");
  for (const g of GREETING_LEADS.sort((a, b) => b.length - a.length)) {
    if (s === g) return { stripped: s, wasStripped: false };
    if (s.startsWith(`${g},`) || s.startsWith(`${g} `)) {
      const rest = s.slice(g.length + 1).trim().replace(/^[,!?.\s]+/, "").trim();
      if (rest) return { stripped: rest, wasStripped: true };
      return { stripped: s, wasStripped: false };
    }
  }
  return { stripped: s, wasStripped: false };
}

const REF_RE = /\b(TKT|AUT|EXC|GEN|IDA|EVT|APT)-[A-Z0-9-]{3,}\b/g;
const CONF_RE = /\b(REF|CMP)-[A-Z0-9-]{3,}\b/g;

export function extractRefsStrict(text: string): string[] {
  const m = String(text || "").toUpperCase().match(REF_RE);
  return m ? [...new Set(m)] : [];
}

export function extractConfidentialRefs(text: string): string[] {
  const m = String(text || "").toUpperCase().match(CONF_RE);
  return m ? [...new Set(m)] : [];
}

export function detectService(normalized: string, tokens: Set<string>): string | null {
  const s = ` ${normalized} `;
  const has = (...ws: string[]) => ws.some((w) => tokens.has(w));
  if (/\bpsych|\bcounsel|\bguidance|\bmental health\b/.test(s) || has("psych", "counsel", "guidance")) return "PSYCH";
  if (has("lostid") || (has("id") && /\blost\b/.test(s))) return "ID_LOST";
  if (has("newid") || (has("id") && /\bnew\b/.test(s))) return "ID_NEW";
  if (has("authentication", "auth")) return "AUTH";
  if (has("excuse")) return "EXCUSE";
  if (has("event")) return "EVENT";
  if (has("generalvisit") || (has("general") && has("appointment"))) return "GENERAL";
  if (has("id")) return "ID_NEW";
  return null;
}

const DATE_HINT_RE = /\btoday\b|\btomorrow\b|\bbukas\b|\byesterday\b|\bnext week\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b/;

export function analyzeMessage(raw: string): WordAnalysis {
  const normalized = normalizeMessage(raw);
  const { stripped } = stripGreetingPrefix(normalized);
  const wasStripped = stripGreetingPrefix(normalized).wasStripped;
  const working = wasStripped ? stripped : normalized;

  const phraseTokens: string[] = [];
  const foundPhrases: string[] = [];
  const sorted = [...PHRASES].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const p of sorted) {
    if (working.includes(p.phrase)) {
      phraseTokens.push(p.token);
      foundPhrases.push(p.phrase);
    }
  }

  const rawTokens = foldDiacritics(working.toLowerCase()).match(/[a-z0-9-]{2,}/g) || [];
  const canonical: string[] = [];
  for (const rt of rawTokens) {
    const c = canonicalizeToken(rt.replace(/^-+|-+$/g, ""));
    if (!c || c.length < 2) continue;
    if (WORD_STOP_WORDS.has(c)) continue;
    // Keep scoring parity with extractKeywords: single chars/digits dropped,
    // meaningful short codes (id, or, tor) kept.
    if (c.length < 3 && c !== "id" && c !== "or" && c !== "tor") continue;
    canonical.push(c);
  }
  for (const pt of phraseTokens) {
    if (!WORD_STOP_WORDS.has(pt)) canonical.push(pt);
  }
  const tokenSet = new Set(canonical);
  return {
    normalized,
    stripped: working,
    wasStripped,
    tokens: [...tokenSet],
    tokenSet,
    phrases: foundPhrases,
    refs: extractRefsStrict(raw),
    confidentialRefs: extractConfidentialRefs(raw),
    service: detectService(working, tokenSet),
    dateHint: DATE_HINT_RE.test(working),
  };
}

// --- Starter intents (superset of the old exact-phrase sets; TL + "po" tolerant) ---

export type StarterIntent = "greeting" | "capabilities" | "thanks" | "farewell" | "guide";

const THANKS_SET = new Set(["thank you", "thanks", "thank u", "salamat", "maraming salamat", "salamat po", "thank you po", "thanks po", "ty"]);
const FAREWELL_SET = new Set(["bye", "goodbye", "goodnight", "good night", "paalam", "see you", "ingat", "bye po", "paalam po"]);
const CAPABILITY_SET = new Set([
  "what can you do", "what do you do", "help", "how can you help",
  "how do i use this", "tulong", "how", "paano", "help po", "tulong po",
  "help me", "need help", "patulong",
]);
const GREETING_SET = new Set([
  "hi", "hello", "hey", "good morning", "good afternoon", "good evening",
  "kumusta", "kamusta", "magandang umaga", "magandang hapon", "magandang gabi",
  "hi po", "hello po", "hey po", "kumusta po", "kamusta po",
]);

/** Back-compat normalizer kept for assistant-pills. */
export function normalizeStarterIntent(message: string): string {
  return normalizeMessage(message);
}

export function matchStarterIntent(message: string): StarterIntent | null {
  const norm = normalizeMessage(message);
  if (GREETING_SET.has(norm)) return "greeting";
  if (THANKS_SET.has(norm)) return "thanks";
  if (FAREWELL_SET.has(norm)) return "farewell";
  if (CAPABILITY_SET.has(norm)) return "capabilities";
  const a = analyzeMessage(message);
  if (a.tokenSet.has("guide")) return "guide";
  if (a.tokenSet.has("capabilities")) return "capabilities";
  return null;
}

export function hasTorIntent(raw: string): boolean {
  return /\btor\b|transcript of records/i.test(String(raw || ""));
}

const BILLING_WORDS = new Set(["billing", "balance", "tuition", "payment", "pay", "fee", "receipt", "bayad", "magkano"]);

export function hasBillingIntentWords(raw: string): boolean {
  const a = analyzeMessage(raw);
  for (const t of a.tokens) if (BILLING_WORDS.has(t)) return true;
  // Tuition/balance questions without other transaction words are billing.
  if (/\boutstanding\b|\bfees\b/.test(a.normalized)) return true;
  return false;
}
