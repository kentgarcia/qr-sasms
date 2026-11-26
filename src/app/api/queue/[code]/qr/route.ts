import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { buildAppointmentQrPayload } from "@/lib/signature";
import { APPOINTMENT_SERVICES, dateISOPHT, serviceLabel, displayStatus } from "@/lib/appointments";

function formatShortDate(dateLabel: string, dateISO?: string): string {
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    const dt = new Date(`${dateISO}T12:00:00+08:00`);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  const dt = new Date(dateLabel);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  return dateLabel;
}

function formatTimeRange(startTime: string, durationMin: number): string {
  const m = String(startTime || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return startTime;
  let hours = Number(m[1]) % 12;
  const mins = Number(m[2]);
  if (m[3].toUpperCase() === "PM") hours += 12;
  const totalEnd = hours * 60 + mins + Math.max(10, durationMin || 30);
  const endH24 = Math.floor(totalEnd / 60) % 24;
  const endM = totalEnd % 60;
  const suffix = endH24 >= 12 ? "PM" : "AM";
  const endH12 = endH24 % 12 || 12;
  const endStr = `${endH12}:${String(endM).padStart(2, "0")} ${suffix}`;
  return `${startTime.trim()} – ${endStr}`;
}

/**
 * GET /api/queue/[code]/qr
 * Returns a signed offline-capable QR data URL (PNG) + payload + student ID card
 * metadata for the student's own appointment (or any appointment for admin/scanner).
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

  const [userRow, masterRow] = await Promise.all([
    prisma.user.findFirst({
      where: { studentId: { equals: entry.studentId, mode: "insensitive" } },
      select: { course: true, year: true },
    }),
    prisma.masterlistEntry.findUnique({
      where: { sn: entry.studentId },
      select: { course: true, year: true },
    }),
  ]);

  const course = (userRow?.course || masterRow?.course || "").trim();
  const year = (userRow?.year || masterRow?.year || "").trim();
  const courseYear = [course, year].filter(Boolean).join(" · ");

  const dateISO = entry.dateISO || dateISOPHT(entry.dateLabel);
  const durationMin = APPOINTMENT_SERVICES[entry.serviceType]?.durationMin || 30;
  const shortDate = formatShortDate(entry.dateLabel, dateISO);
  const timeRange = formatTimeRange(entry.time, durationMin);

  const payload = buildAppointmentQrPayload(entry.code, entry.studentId, dateISO);
  const dataUrl = await QRCode.toDataURL(payload, {
    width: 400,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#160708", light: "#ffffff" },
  });

  return NextResponse.json({
    code: entry.code,
    studentId: entry.studentId,
    name: entry.name,
    course,
    year,
    courseYear,
    dateLabel: entry.dateLabel,
    shortDate,
    time: entry.time,
    timeRange,
    service: entry.serviceType,
    serviceLabel: serviceLabel(entry.serviceType),
    status: entry.status,
    displayStatus: displayStatus(entry.status),
    payload,
    dataUrl,
  });
}
