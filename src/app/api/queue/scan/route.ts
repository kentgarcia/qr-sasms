import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { propagateToLinked } from "@/lib/appointment-sync";
import { parseAppointmentQrPayload } from "@/lib/signature";
import {
  dateISOPHT,
  manilaDateParts,
  maskForManifest,
  normalizeStatus,
  serializeAppointment,
  serviceLabel,
} from "@/lib/appointments";

/**
 * POST /api/queue/scan
 * Verify a scanned appointment QR payload (STARS1|code|sn|dateISO|hmac8) or
 * manual APT-### code, return masked appointment details, and optionally
 * perform automatic check-in.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const payload = String(body?.payload || body?.code || "").trim();
  const autoCheckIn = Boolean(body?.autoCheckIn);
  if (!payload) {
    return jsonError(400, "Please scan a QR code or enter an appointment code.", "MISSING_PAYLOAD");
  }

  const parsed = parseAppointmentQrPayload(payload);
  if (parsed.kind === "invalid") {
    return jsonError(400, "Unrecognized QR code or appointment format.", "INVALID_QR");
  }
  if (parsed.kind === "signed" && !parsed.validSignature) {
    await addAudit("WARN", `Invalid QR signature scanned for ${parsed.code} by ${auth.name}.`);
    return jsonError(400, "This QR pass signature is invalid or tampered.", "INVALID_QR");
  }

  const entry = await prisma.queueEntry.findUnique({ where: { code: parsed.code } });
  if (!entry) {
    return jsonError(404, `Appointment ${parsed.code} was not found.`, "NOT_FOUND");
  }

  if (parsed.kind === "signed" && entry.studentId.toUpperCase() !== parsed.studentId.toUpperCase()) {
    return jsonError(400, "QR pass does not match this appointment record.", "INVALID_QR");
  }

  const status = normalizeStatus(entry.status);
  const todayParts = manilaDateParts(new Date());
  const todayISO = `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-${String(todayParts.day).padStart(2, "0")}`;
  const entryISO = entry.dateISO || dateISOPHT(entry.dateLabel);
  const isToday = !entryISO || entryISO === todayISO;

  let finalEntry = entry;
  let checkedInNow = false;
  let warning: string | null = null;

  if (status === "CANCELLED") {
    warning = "This appointment has been cancelled.";
  } else if (status === "SERVED") {
    warning = "This appointment has already been completed/served.";
  } else if (status === "NO_SHOW") {
    warning = "This appointment was marked as No Show.";
  } else if (status === "PENDING_APPROVAL") {
    warning = "This booking is still awaiting SSO Admin approval.";
  } else if (!isToday) {
    warning = `Scheduled for ${entry.dateLabel} (not today).`;
  } else if (autoCheckIn && ["BOOKED", "RESCHEDULED"].includes(status)) {
    finalEntry = await prisma.queueEntry.update({
      where: { code: entry.code },
      data: { status: "CHECKED_IN" },
    });
    checkedInNow = true;
    const discreet = entry.serviceType === "PSYCH";
    await addAudit(
      "INFO",
      discreet
        ? `${entry.code} checked in via QR scan by ${auth.name}.`
        : `${entry.code} (${serviceLabel(entry.serviceType)}) checked in via QR scan by ${auth.name}.`
    );
    await propagateToLinked(entry, "Checked In", auth.name);
  }

  const masked = maskForManifest(finalEntry, auth.role, auth.studentId);
  const serialized = serializeAppointment(masked);

  return NextResponse.json({
    ok: true,
    verified: parsed.kind === "signed",
    isToday,
    checkedInNow,
    warning,
    appointment: serialized,
  });
}
