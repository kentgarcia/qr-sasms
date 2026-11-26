import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

type Row = { type: string; id: string; who: string; label: string; status: string; archivedAt: string };
const TYPES = ["complaints", "requests", "idApplications", "eventRequests", "referrals", "appointments", "tickets"] as const;

// Super Admin: browse archived records (?type=&q=) and unarchive one (POST {type,id}).
export async function GET(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const type = req.nextUrl.searchParams.get("type") || "";
  const q = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase().slice(0, 80);
  const want = (t: string) => !type || type === t;
  const A = { archivedAt: { not: null } };
  const take = 200, orderBy = { archivedAt: "desc" as const };
  const out: Row[] = [];
  const iso = (d: Date | null) => (d ? d.toISOString() : "");
  if (want("complaints")) (await prisma.complaint.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "complaints", id: r.id, who: r.sn, label: `Complaint · ${r.category}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("requests")) (await prisma.serviceRequest.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "requests", id: r.id, who: r.sn, label: `Request · ${r.service}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("idApplications")) (await prisma.idApplication.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "idApplications", id: r.id, who: r.sn, label: `ID · ${r.type}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("eventRequests")) (await prisma.eventRequest.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "eventRequests", id: r.id, who: r.sn, label: `Event · ${r.title}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("referrals")) (await prisma.referral.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "referrals", id: r.id, who: r.sn, label: `Referral · ${r.category}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("appointments")) (await prisma.queueEntry.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "appointments", id: r.code, who: r.studentId, label: `Appointment · ${r.serviceType}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  if (want("tickets")) (await prisma.ticket.findMany({ where: A, orderBy, take })).forEach((r) => out.push({ type: "tickets", id: r.id, who: r.sn, label: `Ticket · ${r.subject}`, status: r.status, archivedAt: iso(r.archivedAt) }));
  const rows = out.filter((r) => !q || `${r.id} ${r.who} ${r.label} ${r.status}`.toLowerCase().includes(q)).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)).slice(0, 200);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const type = String(body?.type || ""), id = String(body?.id || "");
  if (!(TYPES as readonly string[]).includes(type) || !id) return jsonError(400, "Unknown record.", "INVALID_RECORD");
  const data = { archivedAt: null };
  let n = 0;
  if (type === "complaints") n = (await prisma.complaint.updateMany({ where: { id }, data })).count;
  else if (type === "requests") n = (await prisma.serviceRequest.updateMany({ where: { id }, data })).count;
  else if (type === "idApplications") n = (await prisma.idApplication.updateMany({ where: { id }, data })).count;
  else if (type === "eventRequests") n = (await prisma.eventRequest.updateMany({ where: { id }, data })).count;
  else if (type === "referrals") n = (await prisma.referral.updateMany({ where: { id }, data })).count;
  else if (type === "appointments") n = (await prisma.queueEntry.updateMany({ where: { code: id }, data })).count;
  else if (type === "tickets") n = (await prisma.ticket.updateMany({ where: { id }, data })).count;
  if (!n) return jsonError(404, "Record not found.", "NOT_FOUND");
  await addAudit("INFO", `Archived record ${id} (${type}) restored by ${auth.name}.`);
  return NextResponse.json({ ok: true });
}
