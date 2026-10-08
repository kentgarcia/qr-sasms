import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { serviceLabel } from "@/lib/appointments";
import { getTopUnanswered, getWorstRated } from "@/lib/assistant-curation";

export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const [byCourse, byYear, services, peakTimes, peakTimesByService, appointmentsByService, assistant] = await Promise.all([
    prisma.user.groupBy({ by: ["course"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ["year"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.queueEntry.groupBy({ by: ["serviceType"], _count: { _all: true }, orderBy: { _count: { serviceType: "desc" } } }),
    prisma.queueEntry.groupBy({ by: ["time"], _count: { _all: true }, orderBy: { _count: { time: "desc" } }, take: 8 }),
    prisma.queueEntry.groupBy({ by: ["serviceType", "time"], _count: { _all: true }, orderBy: { _count: { time: "desc" } }, take: 24 }),
    prisma.queueEntry.groupBy({ by: ["serviceType"], _count: { _all: true }, orderBy: { _count: { serviceType: "desc" } } }),
    getAssistantStats(),
  ]);
  return NextResponse.json({
    byCourse: byCourse.map((r) => ({ label: r.course || "Not set", count: r._count._all })),
    byYear: byYear.map((r) => ({ label: r.year || "Not set", count: r._count._all })),
    services: services.map((r) => ({ label: serviceLabel(r.serviceType), count: r._count._all })),
    peakTimes: peakTimes.map((r) => ({ label: r.time, count: r._count._all })),
    peakTimesByService: peakTimesByService.map((r) => ({ service: r.serviceType, label: `${serviceLabel(r.serviceType)} · ${r.time}`, count: r._count._all })),
    appointmentsByService: appointmentsByService.map((r) => ({ label: serviceLabel(r.serviceType), count: r._count._all })),
    assistant,
  });
}

// Phase 2 (AI assistant spec §9): front-door effectiveness — how much the
// assistant answers vs escalates, and which questions it can't answer
// (feeds the Phase 3 FAQ curation loop).
//
// Improvement spec F-2/F-6: per-answer feedback (👍/👎 joins) and per-pill
// tap counts (parsed from CHATBOT_PILL_TAP audit lines).
async function getAssistantStats() {
  const [byConfidence, dataAnswers, ticketsFromChat, totalTickets, feedback, pillTaps] = await Promise.all([
    prisma.chatMessage.groupBy({
      by: ["confidence"],
      where: { role: "assistant" },
      _count: { _all: true },
    }),
    prisma.chatMessage.count({ where: { role: "assistant", dataSource: { not: null } } }),
    prisma.ticket.count({ where: { chatSessionId: { not: null } } }),
    prisma.ticket.count(),
    getFeedbackStats(),
    getPillTaps(),
  ]);
  const counts = Object.fromEntries(byConfidence.map((r) => [r.confidence || "unknown", r._count._all]));
  const total = (counts.high || 0) + (counts.medium || 0) + (counts.low || 0) + (counts.unknown || 0);
  return {
    queries: { total, high: counts.high || 0, medium: counts.medium || 0, low: counts.low || 0 },
    dataAnswers,
    ticketsFromChat,
    escalationRate: totalTickets ? ticketsFromChat / totalTickets : 0,
    topUnanswered: await getTopUnanswered(),
    feedback,
    pillTaps,
  };
}

async function getFeedbackStats() {
  const [byValue, worst] = await Promise.all([
    prisma.chatFeedback.groupBy({ by: ["value"], _count: { _all: true } }),
    getWorstRated(5),
  ]);
  const counts = Object.fromEntries(byValue.map((r) => [String(r.value), r._count._all]));
  const up = counts["1"] || 0;
  const down = counts["-1"] || 0;
  return {
    up,
    down,
    downRate: up + down ? down / (up + down) : 0,
    worstFaqs: worst.filter((w) => w.kind === "faq"),
    worstRules: worst.filter((w) => w.kind === "rule"),
  };
}

async function getPillTaps(limit = 10): Promise<Array<{ label: string; taps: number }>> {
  const logs = await prisma.auditLog.findMany({
    where: { msg: { startsWith: "CHATBOT_PILL_TAP:" } },
    orderBy: { createdAt: "desc" },
    select: { msg: true },
    take: 1000,
  });
  const counts = new Map<string, number>();
  for (const l of logs) {
    const label = l.msg.slice("CHATBOT_PILL_TAP:".length).trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, taps]) => ({ label, taps }))
    .sort((a, b) => b.taps - a.taps)
    .slice(0, limit);
}
