import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";
import {
  getCurationSuggestions,
  getDeadRules,
  getDriftWarnings,
  getRuleSuggestions,
  getWorstRated,
} from "@/lib/assistant-curation";

// Phase 3 curation loop: unanswered-question clusters with a suggested
// category and a possibly-covering FAQ, for admins to turn into verified
// FAQs. Creation itself reuses POST /api/modules/faqs (same validation +
// auto-embed); once the FAQ exists, repeat questions match it and the
// cluster clears on its own — no dismissal state needed.
//
// Improvement spec F-4 adds rule/synonym suggestions, dead rules, settings
// drift warnings, and 👎-heavy answers (all additive fields).
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const [suggestions, ruleSuggestions, deadRules, driftWarnings, worstRated] = await Promise.all([
    getCurationSuggestions(10),
    getRuleSuggestions(5),
    getDeadRules(),
    getDriftWarnings(),
    getWorstRated(5),
  ]);
  return NextResponse.json({ suggestions, ruleSuggestions, deadRules, driftWarnings, worstRated });
}
