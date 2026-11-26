import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

// "October 1, 2026" / "2026-10-01" -> "2026-10-01" (calendar date, no timezone shift).
function toIso(label: string): string | null {
  const s = (label || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(`${s} 12:00:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

type Item = { date: string; time: string; title: string; type: "appointment" | "pickup" | "event"; ref: string; status: string };

// The signed-in student's own dated items, merged for the dashboard calendar. ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const sn = auth.studentId || "";
  const sp = req.nextUrl.searchParams;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("from") || "") ? sp.get("from")! : "0000-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("to") || "") ? sp.get("to")! : "9999-12-31";

  const [visits, requests, idapps, events, holidayRow] = await Promise.all([
    prisma.queueEntry.findMany({ where: { studentId: sn, archivedAt: null, status: { notIn: ["CANCELLED", "NO_SHOW"] } } }),
    prisma.serviceRequest.findMany({ where: { sn, archivedAt: null, pickupDate: { not: "" } } }),
    prisma.idApplication.findMany({ where: { sn, archivedAt: null, pickupDate: { not: "" } } }),
    prisma.eventRequest.findMany({ where: { sn, archivedAt: null, status: { notIn: ["Rejected", "Cancelled", "Disapproved"] } } }),
    prisma.systemSetting.findUnique({ where: { key: "holidays" } }),
  ]);

  const items: Item[] = [];
  for (const v of visits) {
    const d = toIso(v.dateLabel);
    if (d) items.push({ date: d, time: v.time, title: v.serviceType.replace(/_/g, " "), type: "appointment", ref: v.code, status: v.status });
  }
  for (const r of requests) {
    const d = toIso(r.pickupDate);
    if (d) items.push({ date: d, time: r.pickupTime, title: `${r.service.replace(/_/g, " ")} pickup`, type: "pickup", ref: r.id, status: r.status });
  }
  for (const a of idapps) {
    const d = toIso(a.pickupDate);
    if (d) items.push({ date: d, time: a.pickupTime, title: `${a.type} pickup`, type: "pickup", ref: a.id, status: a.status });
  }
  for (const e of events) {
    const d = toIso(e.date);
    if (d) items.push({ date: d, time: e.time, title: `Event: ${e.title}`, type: "event", ref: e.id, status: e.status });
  }

  let closed: string[] = [];
  try { closed = (JSON.parse(holidayRow?.value || "[]") as string[]).map((h) => toIso(h)).filter((x): x is string => !!x); } catch { /* ignore */ }

  const inRange = (d: string) => d >= from && d <= to;
  return NextResponse.json({
    items: items.filter((i) => inRange(i.date)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    closed: closed.filter(inRange),
  });
}
