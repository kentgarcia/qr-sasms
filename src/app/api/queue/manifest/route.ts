import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { isKnownService, maskForManifest, serializeAppointment } from "@/lib/appointments";

/** Day manifest: filter by date + service. Psych rows are masked for scanners. */
export async function GET(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;
  const params = req.nextUrl.searchParams;
  const dateLabel = params.get("date") ||
    new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const service = (params.get("service") || "").toUpperCase();
  const where: Record<string, unknown> = { dateLabel, status: { not: "CANCELLED" } };
  if (service) {
    if (!isKnownService(service)) return jsonError(400, "Unknown service.", "SERVICE_NOT_OFFERED");
    where.serviceType = service;
  }
  const rows = await prisma.queueEntry.findMany({ where, orderBy: [{ time: "asc" }, { createdAt: "asc" }] });
  const masked = rows.map((r) => maskForManifest(r, auth.role, auth.studentId));
  return NextResponse.json({
    date: dateLabel,
    service: service || null,
    count: masked.length,
    appointments: masked.map(serializeAppointment),
  });
}
