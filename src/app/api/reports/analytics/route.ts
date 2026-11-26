import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { normalizeStatus, serviceLabel } from "@/lib/appointments";
import { requestServiceLabel } from "@/lib/service-requests";
import { getTopUnanswered, getWorstRated } from "@/lib/assistant-curation";
import { fnow } from "@/lib/format";

function parseDateBounds(fromParam: string | null, toParam: string | null) {
  const from = fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : null;
  const to = toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam) ? toParam : null;
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (from) {
    const d = new Date(`${from}T00:00:00+08:00`);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999+08:00`);
    if (!Number.isNaN(d.getTime())) createdAt.lte = d;
  }
  return {
    from,
    to,
    createdAt: Object.keys(createdAt).length ? createdAt : undefined,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const { from, to, createdAt } = parseDateBounds(
    req.nextUrl.searchParams.get("from"),
    req.nextUrl.searchParams.get("to")
  );
  const dateWhere = createdAt ? { createdAt } : undefined;

  const [
    byCourse,
    byYear,
    services,
    peakTimes,
    peakTimesByService,
    appointmentsByService,
    queueRows,
    reqTrendRows,
    completedReqs,
    completedIdApps,
    feedbackRows,
    assistant,
  ] = await Promise.all([
    prisma.user.groupBy({ by: ["course"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ["year"], where: { role: "STUDENT" }, _count: { _all: true } }),
    prisma.queueEntry.groupBy({ by: ["serviceType"], where: dateWhere, _count: { _all: true }, orderBy: { _count: { serviceType: "desc" } } }),
    prisma.queueEntry.groupBy({ by: ["time"], where: dateWhere, _count: { _all: true }, orderBy: { _count: { time: "desc" } }, take: 8 }),
    prisma.queueEntry.groupBy({ by: ["serviceType", "time"], where: dateWhere, _count: { _all: true }, orderBy: { _count: { time: "desc" } }, take: 24 }),
    prisma.queueEntry.groupBy({ by: ["serviceType"], where: dateWhere, _count: { _all: true }, orderBy: { _count: { serviceType: "desc" } } }),
    prisma.queueEntry.findMany({ where: dateWhere, select: { status: true, served: true, createdAt: true } }),
    prisma.serviceRequest.findMany({ where: dateWhere, select: { createdAt: true } }),
    prisma.serviceRequest.findMany({
      where: { ...(dateWhere || {}), status: "Completed" },
      select: { createdAt: true, pickedUpAt: true, updatedAt: true },
    }),
    prisma.idApplication.findMany({
      where: { ...(dateWhere || {}), status: { in: ["Claimed", "Completed"] }, pickedUpAt: { not: null } },
      select: { createdAt: true, pickedUpAt: true },
    }),
    prisma.serviceFeedback.findMany({
      where: dateWhere,
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    getAssistantStats(dateWhere),
  ]);

  // Operational metrics
  let servedCount = 0;
  let noShowCount = 0;
  let cancelledCount = 0;
  let pendingCount = 0;
  let activeCount = 0;
  for (const row of queueRows) {
    const st = normalizeStatus(row.status);
    if (row.served || st === "SERVED") servedCount++;
    else if (st === "NO_SHOW") noShowCount++;
    else if (st === "CANCELLED") cancelledCount++;
    else if (st === "PENDING_APPROVAL") pendingCount++;
    else activeCount++;
  }
  const totalAppointments = queueRows.length;
  const resolvedBase = servedCount + noShowCount + cancelledCount;
  const completionRate = totalAppointments ? Math.round((servedCount / totalAppointments) * 100) : 0;
  const noShowRate = resolvedBase ? Math.round((noShowCount / resolvedBase) * 100) : 0;
  const cancellationRate = totalAppointments ? Math.round((cancelledCount / totalAppointments) * 100) : 0;

  // Turnaround time (hours from submission to completion/pickup)
  const turnaroundHours: number[] = [];
  for (const r of completedReqs) {
    const end = r.pickedUpAt || r.updatedAt;
    const diffH = (end.getTime() - r.createdAt.getTime()) / 3_600_000;
    if (diffH >= 0 && diffH < 24 * 180) turnaroundHours.push(diffH);
  }
  for (const id of completedIdApps) {
    if (!id.pickedUpAt) continue;
    const diffH = (id.pickedUpAt.getTime() - id.createdAt.getTime()) / 3_600_000;
    if (diffH >= 0 && diffH < 24 * 180) turnaroundHours.push(diffH);
  }
  const avgTurnaroundHours = turnaroundHours.length
    ? Math.round((turnaroundHours.reduce((a, b) => a + b, 0) / turnaroundHours.length) * 10) / 10
    : null;

  // Activity trend series (daily if span <= 45d, otherwise monthly)
  const trend = buildActivityTrend(
    queueRows.map((r) => r.createdAt),
    reqTrendRows.map((r) => r.createdAt)
  );

  // CSAT metrics
  const csat = await buildCsatSummary(feedbackRows);

  return NextResponse.json({
    range: { from, to },
    trend,
    byCourse: byCourse.map((r) => ({ label: r.course || "Not set", count: r._count._all })),
    byYear: byYear.map((r) => ({ label: r.year || "Not set", count: r._count._all })),
    services: services.map((r) => ({ label: serviceLabel(r.serviceType), count: r._count._all })),
    peakTimes: peakTimes.map((r) => ({ label: r.time, count: r._count._all })),
    peakTimesByService: peakTimesByService.map((r) => ({ service: r.serviceType, label: `${serviceLabel(r.serviceType)} · ${r.time}`, count: r._count._all })),
    appointmentsByService: appointmentsByService.map((r) => ({ label: serviceLabel(r.serviceType), count: r._count._all })),
    operations: {
      totalAppointments,
      servedCount,
      noShowCount,
      cancelledCount,
      activeCount,
      pendingCount,
      completionRate,
      noShowRate,
      cancellationRate,
      avgTurnaroundHours,
      completedRequestsCount: turnaroundHours.length,
    },
    csat,
    assistant,
  });
}

function buildActivityTrend(apptDates: Date[], reqDates: Date[]) {
  const all = [...apptDates, ...reqDates].sort((a, b) => a.getTime() - b.getTime());
  if (!all.length) return [];
  const spanDays = (all[all.length - 1].getTime() - all[0].getTime()) / 86_400_000;
  const byMonth = spanDays > 45;
  const keyOf = (d: Date) => {
    const iso = d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    return byMonth ? iso.slice(0, 7) : iso;
  };
  const labelOf = (k: string) => {
    if (byMonth) {
      const dt = new Date(`${k}-01T12:00:00+08:00`);
      return Number.isNaN(dt.getTime()) ? k : dt.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    }
    const dt = new Date(`${k}T12:00:00+08:00`);
    return Number.isNaN(dt.getTime()) ? k : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const buckets = new Map<string, { appointments: number; requests: number }>();
  for (const d of apptDates) {
    const k = keyOf(d);
    const cur = buckets.get(k) || { appointments: 0, requests: 0 };
    cur.appointments += 1;
    buckets.set(k, cur);
  }
  for (const d of reqDates) {
    const k = keyOf(d);
    const cur = buckets.get(k) || { appointments: 0, requests: 0 };
    cur.requests += 1;
    buckets.set(k, cur);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14)
    .map(([k, v]) => ({ key: k, label: labelOf(k), appointments: v.appointments, requests: v.requests }));
}

async function buildCsatSummary(
  rows: Array<{ id: string; requestId: string; studentId: string; rating: number; comment: string; createdAt: Date }>
) {
  const ids = rows.map((r) => r.requestId);
  const svcMap = new Map<string, string>();
  if (ids.length) {
    const [appts, reqs, idapps, evts, refs, tickets] = await Promise.all([
      prisma.queueEntry.findMany({ where: { code: { in: ids } }, select: { code: true, serviceType: true } }),
      prisma.serviceRequest.findMany({ where: { id: { in: ids } }, select: { id: true, service: true } }),
      prisma.idApplication.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } }),
      prisma.eventRequest.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      prisma.referral.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      prisma.ticket.findMany({ where: { id: { in: ids } }, select: { id: true, category: true } }),
    ]);
    for (const a of appts) svcMap.set(a.code, serviceLabel(a.serviceType));
    for (const r of reqs) svcMap.set(r.id, requestServiceLabel(r.service));
    for (const i of idapps) svcMap.set(i.id, i.type || "ID Application");
    for (const e of evts) svcMap.set(e.id, "Event Request");
    for (const r of refs) svcMap.set(r.id, "Referral & Intervention");
    for (const t of tickets) svcMap.set(t.id, t.category ? `Help Desk · ${t.category}` : "Help Desk Ticket");
  }

  const total = rows.length;
  const dist: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  const bySvc = new Map<string, { sum: number; count: number }>();
  let sum = 0;
  let positiveCount = 0;
  let commentCount = 0;

  for (const r of rows) {
    const star = Math.min(5, Math.max(1, r.rating));
    sum += star;
    if (star >= 4) positiveCount += 1;
    if (r.comment && r.comment.trim()) commentCount += 1;
    dist[star] = (dist[star] || 0) + 1;
    const label = svcMap.get(r.requestId) || "SSO Service";
    const cur = bySvc.get(label) || { sum: 0, count: 0 };
    cur.sum += star;
    cur.count += 1;
    bySvc.set(label, cur);
  }

  return {
    total,
    average: total ? Math.round((sum / total) * 100) / 100 : 0,
    positiveRate: total ? Math.round((positiveCount / total) * 100) : 0,
    commentCount,
    distribution: [5, 4, 3, 2, 1].map((star) => ({ star, label: `${star} ★`, count: dist[star] || 0 })),
    byService: [...bySvc.entries()]
      .map(([label, v]) => ({
        label,
        average: Math.round((v.sum / v.count) * 100) / 100,
        count: v.count,
      }))
      .sort((a, b) => b.count - a.count),
    recent: rows.slice(0, 60).map((r) => ({
      requestId: r.requestId,
      studentId: r.studentId,
      serviceLabel: svcMap.get(r.requestId) || "SSO Service",
      rating: r.rating,
      comment: r.comment,
      ts: fnow(r.createdAt),
    })),
  };
}

async function getAssistantStats(dateWhere?: { createdAt: { gte?: Date; lte?: Date } }) {
  const [byConfidence, dataAnswers, ticketsFromChat, totalTickets, feedback, pillTaps] = await Promise.all([
    prisma.chatMessage.groupBy({
      by: ["confidence"],
      where: { role: "assistant", ...(dateWhere || {}) },
      _count: { _all: true },
    }),
    prisma.chatMessage.count({ where: { role: "assistant", dataSource: { not: null }, ...(dateWhere || {}) } }),
    prisma.ticket.count({ where: { chatSessionId: { not: null }, ...(dateWhere || {}) } }),
    prisma.ticket.count({ where: dateWhere }),
    getFeedbackStats(dateWhere),
    getPillTaps(10, dateWhere),
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

async function getFeedbackStats(dateWhere?: { createdAt: { gte?: Date; lte?: Date } }) {
  const [byValue, worst] = await Promise.all([
    prisma.chatFeedback.groupBy({ by: ["value"], where: dateWhere, _count: { _all: true } }),
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

async function getPillTaps(
  limit = 10,
  dateWhere?: { createdAt: { gte?: Date; lte?: Date } }
): Promise<Array<{ label: string; taps: number }>> {
  const logs = await prisma.auditLog.findMany({
    where: { msg: { startsWith: "CHATBOT_PILL_TAP:" }, ...(dateWhere || {}) },
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
