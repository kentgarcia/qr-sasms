import { prisma } from "./prisma";
import { extractKeywords, getAssistantSimilarities } from "./assistant";
import { embedText, searchSimilar } from "./embeddings";
import { analyzeMessage } from "./assistant-words";
import { TX_RULES } from "./assistant-rules";
import { getScheduleSettings, getServiceConfigs } from "./appointments";

// Phase 3 of docs/ai-assistant-ticket-escalation-spec.md — the curation loop.
//
// Unanswered-question clusters (from low-confidence answers) are surfaced to
// admins, who turn them into verified FAQs with one click. The loop is
// self-clearing: once an FAQ exists, repeat questions match it instead of
// landing back here. No dismissal state is stored.

export type UnansweredCluster = { question: string; count: number };

export type CurationSuggestion = UnansweredCluster & {
  suggestedCategory: string;
  // Closest existing FAQ, when the embedding backend is up — warns the admin
  // that the cluster may already be covered instead of needing a new FAQ.
  similarFaq: { faqId: string; q: string; similarity: number } | null;
};

export async function getTopUnanswered(limit = 10): Promise<UnansweredCluster[]> {
  const lows = await prisma.chatMessage.findMany({
    where: { role: "assistant", confidence: "low" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { sessionId: true, createdAt: true },
  });
  if (!lows.length) return [];
  const sessionIds = [...new Set(lows.map((l) => l.sessionId))];
  const studentMsgs = await prisma.chatMessage.findMany({
    where: { role: "student", sessionId: { in: sessionIds } },
    select: { sessionId: true, text: true, createdAt: true },
  });
  const bySession = new Map<string, Array<{ text: string; createdAt: Date }>>();
  for (const m of studentMsgs) {
    const list = bySession.get(m.sessionId) || [];
    list.push(m);
    bySession.set(m.sessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const counts = new Map<string, UnansweredCluster>();
  for (const low of lows) {
    const prior = (bySession.get(low.sessionId) || []).filter((m) => m.createdAt <= low.createdAt).at(-1);
    if (!prior) continue;
    const key = prior.text.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 140);
    if (!key) continue;
    const entry = counts.get(key) || { question: prior.text.trim().slice(0, 140), count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

// Suggest a category by keyword overlap with existing category names.
// Returns "" when nothing overlaps — the admin picks.
export async function suggestCategory(question: string): Promise<string> {
  const cats = await prisma.faqCategory.findMany({ select: { name: true } });
  const names = cats.map((c) => c.name);
  if (!names.length) return "";
  const keywords = new Set(extractKeywords(question));
  let best = "";
  let bestScore = 0;
  for (const name of names) {
    const words = String(name).toLowerCase().match(/[a-z]{3,}/g) || [];
    const score = words.filter((w) => keywords.has(w) || keywords.has(w.replace(/s$/, ""))).length;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

export async function getCurationSuggestions(limit = 10): Promise<CurationSuggestion[]> {
  const clusters = await getTopUnanswered(limit);
  const faqs = await prisma.faq.findMany({ select: { id: true, cat: true, q: true } });
  const byId = new Map(faqs.map((f) => [f.id, f]));
  // Only flag an existing FAQ as "possibly covering" when it's close enough
  // to matter — low-similarity noise would mislead the admin.
  const { medium } = await getAssistantSimilarities();
  return Promise.all(
    clusters.map(async (c) => {
      const [suggestedCategory, similar] = await Promise.all([
        suggestCategory(c.question),
        (async () => {
          const vec = await embedText(c.question);
          if (!vec) return null;
          try {
            const sims = await searchSimilar(vec, 1);
            const top = sims[0];
            const faq = top ? byId.get(top.faqId) : undefined;
            if (!faq || top.similarity < medium) return null;
            return { faqId: faq.id, q: faq.q, similarity: top.similarity };
          } catch {
            return null;
          }
        })(),
      ]);
      return { ...c, suggestedCategory, similarFaq: similar };
    })
  );
}

// ── Improvement spec F-4: curation v2 ────────────────────────────

export type RuleSuggestion = {
  ruleId: string;
  intent: string;
  /** Needs-tokens the cluster kept missing (synonym candidates). */
  missingNeeds: string[];
  count: number;
};

/** Clusters that smell like a rule/synonym gap, not a missing FAQ. */
export async function getRuleSuggestions(limit = 5): Promise<RuleSuggestion[]> {
  const clusters = await getTopUnanswered(20);
  const acc = new Map<string, { intent: string; missing: Map<string, number>; count: number }>();
  for (const c of clusters) {
    const tokens = analyzeMessage(c.question).tokenSet;
    for (const rule of TX_RULES) {
      if (!rule.wants.some((w) => tokens.has(w))) continue;
      const missing = rule.needs.filter((n) => !tokens.has(n));
      if (!missing.length) continue; // would plausibly have fired already
      let entry = acc.get(rule.id);
      if (!entry) {
        entry = { intent: rule.intent, missing: new Map(), count: 0 };
        acc.set(rule.id, entry);
      }
      entry.count += c.count;
      for (const m of missing) entry.missing.set(m, (entry.missing.get(m) || 0) + c.count);
    }
  }
  return [...acc.entries()]
    .map(([ruleId, e]) => ({
      ruleId,
      intent: e.intent,
      missingNeeds: [...e.missing.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, 3),
      count: e.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

const KNOWN_NONFAQ_RULE_IDS = [
  "guide-nudge",
  "tor-guard",
  "billing-notice",
  "confidential-redirect",
  "intent:greeting",
  "intent:thanks",
  "intent:farewell",
  "intent:capabilities",
];

const RULE_ID_RE = /^FAQ_CHATBOT_QUERY:rule:([A-Za-z0-9:_-]+)/;

/** Rule ids with zero audit hits in 30 days — merge/remove candidates. */
export async function getDeadRules(): Promise<Array<{ ruleId: string; intent: string }>> {
  const since = new Date(Date.now() - 30 * 86400000);
  const logs = await prisma.auditLog.findMany({
    where: { msg: { startsWith: "FAQ_CHATBOT_QUERY:rule:" }, createdAt: { gte: since } },
    select: { msg: true },
    take: 5000,
  });
  const seen = new Set<string>();
  for (const l of logs) {
    const m = RULE_ID_RE.exec(l.msg);
    if (m) seen.add(m[1]);
  }
  const intents = new Map<string, string>(TX_RULES.map((r) => [r.id, r.intent]));
  for (const id of KNOWN_NONFAQ_RULE_IDS) {
    if (!intents.has(id)) intents.set(id, id.replace(/^intent:/, ""));
  }
  return [...intents.entries()]
    .filter(([id]) => !seen.has(id))
    .map(([ruleId, intent]) => ({ ruleId, intent }));
}

export type DriftWarning = { fact: string; setting: string; current: string };

/** Hardcoded reply facts re-checked against live config (advisory only). */
export async function getDriftWarnings(): Promise<DriftWarning[]> {
  const out: DriftWarning[] = [];
  try {
    const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
    if (settings.cutoffHours !== 24) {
      out.push({
        fact: 'Rule replies promise a "24-hour" reschedule/cancel cutoff',
        setting: "cancellationCutoffHours",
        current: String(settings.cutoffHours),
      });
    }
    if (settings.maxReschedules !== 2) {
      out.push({
        fact: 'Rule replies promise "up to 2 reschedules" per appointment',
        setting: "maxReschedules",
        current: String(settings.maxReschedules),
      });
    }
    const hours = settings.hours || [];
    if (hours[0] !== "8:00 AM" || hours[hours.length - 1] !== "5:00 PM") {
      out.push({
        fact: 'Rule replies state office hours "8:00 AM – 5:00 PM"',
        setting: "businessHours",
        current: hours.length ? `${hours[0]} … ${hours[hours.length - 1]}` : "(empty)",
      });
    }
    const psychMin = configs.PSYCH?.durationMin;
    if (psychMin !== undefined && psychMin !== 45) {
      out.push({
        fact: 'Referral guidance promises "45-minute" intervention slots',
        setting: "ServiceSlotConfig PSYCH.durationMin",
        current: String(psychMin),
      });
    }
  } catch {
    // Settings unreadable — no warnings rather than wrong ones.
  }
  return out;
}

export type WorstRated = { kind: "faq" | "rule"; id: string; label: string; down: number };

const RULE_MSG_RE = /^FAQ_CHATBOT_QUERY:rule:(\S+).* msg:(\S+)\s*$/;

/** 👎-heavy answers, exact-joined via feedback → message → audit msg id. */
export async function getWorstRated(limit = 5): Promise<WorstRated[]> {
  const downs = await prisma.chatFeedback.findMany({
    where: { value: -1 },
    select: { messageId: true },
    take: 500,
  });
  if (!downs.length) return [];
  const downIds = [...new Set(downs.map((d) => d.messageId))];
  const [msgs, audits] = await Promise.all([
    prisma.chatMessage.findMany({ where: { id: { in: downIds } }, select: { id: true, faqId: true } }),
    prisma.auditLog.findMany({
      where: { msg: { startsWith: "FAQ_CHATBOT_QUERY:rule:" } },
      select: { msg: true },
      take: 5000,
    }),
  ]);
  const msgToRule = new Map<string, string>();
  for (const a of audits) {
    const m = RULE_MSG_RE.exec(a.msg);
    if (m) msgToRule.set(m[2], m[1]);
  }
  const faqDown = new Map<string, number>();
  const ruleDown = new Map<string, number>();
  for (const m of msgs) {
    if (m.faqId) faqDown.set(m.faqId, (faqDown.get(m.faqId) || 0) + 1);
    const rule = msgToRule.get(m.id);
    if (rule) ruleDown.set(rule, (ruleDown.get(rule) || 0) + 1);
  }
  const faqs = faqDown.size
    ? await prisma.faq.findMany({ where: { id: { in: [...faqDown.keys()] } }, select: { id: true, q: true } })
    : [];
  const faqQ = new Map(faqs.map((f) => [f.id, f.q]));
  const ruleIntent = new Map(TX_RULES.map((r) => [r.id, r.intent]));
  const out: WorstRated[] = [
    ...[...faqDown.entries()].map(([id, down]) => ({
      kind: "faq" as const,
      id,
      label: (faqQ.get(id) || id).slice(0, 80),
      down,
    })),
    ...[...ruleDown.entries()].map(([id, down]) => ({
      kind: "rule" as const,
      id,
      label: ruleIntent.get(id) || id,
      down,
    })),
  ];
  return out.sort((a, b) => b.down - a.down).slice(0, limit);
}
