import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { buildAppointmentQrPayload } from "@/lib/signature";
import { dateISOPHT, serviceLabel, displayStatus } from "@/lib/appointments";

/**
 * GET /api/queue/[code]/qr
 * Returns a signed offline-capable QR data URL (PNG) + payload for the student's
 * own appointment (or any appointment for admin/super_admin/scanner).
 */
export async function GET(_req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student", "admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const code = decodeURIComponent(params.code).toUpperCase();
  const entry = await prisma.queueEntry.findUnique({ where: { code } });
  if (!entry) return jsonError(404, "Appointment not found.", "NOT_FOUND");

  if (auth.role === "student" && entry.studentId.toUpperCase() !== (auth.studentId || "").toUpperCase()) {
    return jsonError(403, "You can only access your own appointment QR pass.", "FORBIDDEN");
  }

  const dateISO = entry.dateISO || dateISOPHT(entry.dateLabel);
  const payload = buildAppointmentQrPayload(entry.code, entry.studentId, dateISO);
  const dataUrl = await QRCode.toDataURL(payload, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#1a0505", light: "#ffffff" },
  });

  return NextResponse.json({
    code: entry.code,
    studentId: entry.studentId,
    name: entry.name,
    dateLabel: entry.dateLabel,
    time: entry.time,
    service: entry.serviceType,
    serviceLabel: serviceLabel(entry.serviceType),
    status: entry.status,
    displayStatus: displayStatus(entry.status),
    payload,
    dataUrl,
  });
}
