import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { buildAppointmentIcs } from "@/lib/calendar";
import { serviceLabel } from "@/lib/appointments";

/**
 * GET /api/queue/[code]/ics
 * Downloads a standard RFC 5545 .ics calendar invite for the appointment.
 */
export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student", "admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const code = decodeURIComponent(params.code).toUpperCase();
  const entry = await prisma.queueEntry.findUnique({ where: { code } });
  if (!entry) return jsonError(404, "Appointment not found.", "NOT_FOUND");

  if (auth.role === "student" && entry.studentId.toUpperCase() !== (auth.studentId || "").toUpperCase()) {
    return jsonError(403, "You can only export your own appointments.", "FORBIDDEN");
  }

  const ics = buildAppointmentIcs({
    code: entry.code,
    service: entry.serviceType,
    serviceLabel: serviceLabel(entry.serviceType),
    dateLabel: entry.dateLabel,
    time: entry.time,
    slotStartAt: entry.slotStartAt,
    slotEndAt: entry.slotEndAt,
    studentName: entry.name,
    studentId: entry.studentId,
    purpose: entry.purpose || undefined,
    notes: entry.serviceType === "PSYCH" ? undefined : entry.notes || undefined,
  });

  const safeFile = entry.code.replace(/[^A-Za-z0-9_-]/g, "");
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="STARS-${safeFile}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
