import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { fnow } from "@/lib/format";
import { serviceLabel } from "@/lib/appointments";
import { requestServiceLabel } from "@/lib/service-requests";

function parseDateBounds(fromParam: string | null, toParam: string | null) {
  const filter: { gte?: Date; lte?: Date } = {};
  if (fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)) {
    const d = new Date(`${fromParam}T00:00:00+08:00`);
    if (!Number.isNaN(d.getTime())) filter.gte = d;
  }
  if (toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
    const d = new Date(`${toParam}T23:59:59.999+08:00`);
    if (!Number.isNaN(d.getTime())) filter.lte = d;
  }
  return Object.keys(filter).length ? filter : undefined;
}

async function resolveServiceMap(requestIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!requestIds.length) return map;
  const [appts, reqs, idapps, evts, refs, tickets] = await Promise.all([
    prisma.queueEntry.findMany({ where: { code: { in: requestIds } }, select: { code: true, serviceType: true } }),
    prisma.serviceRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, service: true } }),
    prisma.idApplication.findMany({ where: { id: { in: requestIds } }, select: { id: true, type: true } }),
    prisma.eventRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true } }),
    prisma.referral.findMany({ where: { id: { in: requestIds } }, select: { id: true } }),
    prisma.ticket.findMany({ where: { id: { in: requestIds } }, select: { id: true, category: true } }),
  ]);
  for (const a of appts) map.set(a.code, serviceLabel(a.serviceType));
  for (const r of reqs) map.set(r.id, requestServiceLabel(r.service));
  for (const i of idapps) map.set(i.id, i.type || "ID Application");
  for (const e of evts) map.set(e.id, "Event Request");
  for (const r of refs) map.set(r.id, "Referral & Intervention");
  for (const t of tickets) map.set(t.id, t.category ? `Help Desk · ${t.category}` : "Help Desk Ticket");
  return map;
}

/**
 * GET /api/feedback
 * - Student: returns their submitted CSAT ratings.
 * - Admin / Super Admin: returns aggregate CSAT summary + recent entries.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSession(["student", "admin"]);
  if (auth instanceof NextResponse) return auth;

  if (auth.role === "student") {
    const rows = await prisma.serviceFeedback.findMany({
      where: { studentId: auth.studentId || "" },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        requestId: r.requestId,
        rating: r.rating,
        comment: r.comment,
        ts: fnow(r.createdAt),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }

  const createdAt = parseDateBounds(req.nextUrl.searchParams.get("from"), req.nextUrl.searchParams.get("to"));
  const rows = await prisma.serviceFeedback.findMany({
    where: createdAt ? { createdAt } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const svcMap = await resolveServiceMap(rows.map((r) => r.requestId));
  const total = rows.length;
  const sum = rows.reduce((acc, r) => acc + r.rating, 0);
  const average = total ? Math.round((sum / total) * 100) / 100 : 0;
  const distCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  const svcAgg = new Map<string, { sum: number; count: number }>();

  for (const r of rows) {
    const star = Math.min(5, Math.max(1, r.rating));
    distCounts[star] = (distCounts[star] || 0) + 1;
    const label = svcMap.get(r.requestId) || "SSO Service";
    const cur = svcAgg.get(label) || { sum: 0, count: 0 };
    cur.sum += star;
    cur.count += 1;
    svcAgg.set(label, cur);
  }

  return NextResponse.json({
    summary: {
      total,
      average,
      distribution: [5, 4, 3, 2, 1].map((star) => ({ star, count: distCounts[star] || 0 })),
      byService: [...svcAgg.entries()]
        .map(([label, v]) => ({
          label,
          average: Math.round((v.sum / v.count) * 100) / 100,
          count: v.count,
        }))
        .sort((a, b) => b.count - a.count),
    },
    items: rows.slice(0, 100).map((r) => ({
      id: r.id,
      requestId: r.requestId,
      studentId: r.studentId,
      serviceLabel: svcMap.get(r.requestId) || "SSO Service",
      rating: r.rating,
      comment: r.comment,
      ts: fnow(r.createdAt),
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

/**
 * POST /api/feedback
 * Student submits a 1–5 star CSAT rating for a completed appointment or request.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const requestId = String(body?.requestId || "").trim();
  const rating = Math.round(Number(body?.rating));
  const comment = String(body?.comment || "").trim().slice(0, 500);

  if (!requestId) return jsonError(400, "Missing transaction reference.", "MISSING_FIELDS");
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return jsonError(400, "Rating must be a whole number from 1 to 5.", "INVALID_RATING");
  }

  const sn = auth.studentId || "";
  if (!sn) return jsonError(403, "Student number not found on session.", "FORBIDDEN");

  // Verify ownership and completed/closed status across all student transaction types.
  const [appt, sreq, idapp, evt, ref, ticket] = await Promise.all([
    prisma.queueEntry.findUnique({ where: { code: requestId }, select: { studentId: true, status: true, served: true, serviceType: true } }),
    prisma.serviceRequest.findUnique({ where: { id: requestId }, select: { sn: true, status: true, service: true } }),
    prisma.idApplication.findUnique({ where: { id: requestId }, select: { sn: true, status: true, type: true } }),
    prisma.eventRequest.findUnique({ where: { id: requestId }, select: { sn: true, status: true } }),
    prisma.referral.findUnique({ where: { id: requestId }, select: { sn: true, status: true } }),
    prisma.ticket.findUnique({ where: { id: requestId }, select: { sn: true, status: true, category: true } }),
  ]);

  let eligible = false;
  let ownerMatch = false;
  let label = "SSO Service";

  if (appt) {
    ownerMatch = appt.studentId.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && (appt.served || appt.status === "SERVED");
    label = serviceLabel(appt.serviceType);
  } else if (sreq) {
    ownerMatch = sreq.sn.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && /^(completed|claimed)$/i.test(sreq.status);
    label = requestServiceLabel(sreq.service);
  } else if (idapp) {
    ownerMatch = idapp.sn.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && /^(claimed|completed)$/i.test(idapp.status);
    label = idapp.type || "ID Application";
  } else if (evt) {
    ownerMatch = evt.sn.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && /^(completed|approved)$/i.test(evt.status);
    label = "Event Request";
  } else if (ref) {
    ownerMatch = ref.sn.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && /^(completed|resolved)$/i.test(ref.status);
    label = "Referral & Intervention";
  } else if (ticket) {
    ownerMatch = ticket.sn.toUpperCase() === sn.toUpperCase();
    eligible = ownerMatch && /^closed$/i.test(ticket.status);
    label = ticket.category ? `Help Desk · ${ticket.category}` : "Help Desk Ticket";
  } else {
    return jsonError(404, "Transaction not found.", "NOT_FOUND");
  }

  if (!ownerMatch) {
    return jsonError(403, "You can only rate your own completed transactions.", "FORBIDDEN");
  }
  if (!eligible) {
    return jsonError(409, "Feedback can only be submitted after the visit, request, or ticket is completed.", "NOT_COMPLETED");
  }

  const existing = await prisma.serviceFeedback.findUnique({ where: { requestId } });
  if (existing) {
    return jsonError(409, "You have already submitted feedback for this transaction.", "ALREADY_RATED");
  }

  const created = await prisma.serviceFeedback.create({
    data: { requestId, studentId: sn, rating, comment },
  });

  await addAudit("INFO", `CSAT feedback (${rating}/5) submitted for ${requestId} (${label}) by ${sn}.`);

  return NextResponse.json(
    {
      ok: true,
      feedback: {
        id: created.id,
        requestId: created.requestId,
        rating: created.rating,
        comment: created.comment,
        ts: fnow(created.createdAt),
        createdAt: created.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
