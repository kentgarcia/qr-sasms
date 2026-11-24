import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { dateISOPHT, normalizeStatus, PENDING_APPROVAL, serviceLabel } from "@/lib/appointments";
import { propagateToLinked } from "@/lib/appointment-sync";

/**
 * POST /api/queue/batch-status
 * Batch appointment lifecycle transitions for SSO Admin / Super Admin.
 * Body: { codes: string[], action: "approve" | "reject" | "checkin" | "serve" | "noshow", reason?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const rawCodes = Array.isArray(body?.codes) ? body.codes : [];
  const rawAction = String(body?.action || "").toLowerCase();
  const action = rawAction === "complete" ? "serve" : rawAction;
  const reason = body?.reason ? String(body.reason).trim().slice(0, 300) : null;

  if (!["approve", "reject", "checkin", "serve", "noshow"].includes(action)) {
    return jsonError(400, "Invalid batch action.", "INVALID_ACTION");
  }

  const codes: string[] = Array.from(
    new Set<string>(rawCodes.map((c: unknown) => String(c || "").trim().toUpperCase()).filter(Boolean))
  ).slice(0, 100);
  if (!codes.length) {
    return jsonError(400, "Select at least one appointment.", "MISSING_FIELDS");
  }

  const entries = await prisma.queueEntry.findMany({ where: { code: { in: codes } } });
  let processed = 0;
  let skipped = codes.length - entries.length;
  const errors: Array<{ code: string; reason: string }> = [];

  for (const entry of entries) {
    const status = normalizeStatus(entry.status);
    const code = entry.code;

    if (action === "approve") {
      if (status !== PENDING_APPROVAL) {
        skipped++;
        errors.push({ code, reason: `Status is ${status}` });
        continue;
      }
      await prisma.queueEntry.update({ where: { code }, data: { status: "BOOKED" } });
      await propagateToLinked(entry, "Approved", auth.name);
      await notifyStudentByEmail({
        studentId: entry.studentId,
        name: entry.name,
        title: "Appointment Approved",
        message: `Your appointment ${code} (${serviceLabel(entry.serviceType)}) on ${entry.dateLabel} at ${entry.time} has been approved and confirmed. See you then!`,
        ref: code,
        qrAppointment: {
          code,
          studentId: entry.studentId,
          dateISO: entry.dateISO || dateISOPHT(entry.dateLabel),
          dateLabel: entry.dateLabel,
          time: entry.time,
          serviceLabel: serviceLabel(entry.serviceType),
        },
      });
      await addNotification(entry.studentId, "Appointment Approved", `Your appointment ${code} on ${entry.dateLabel} at ${entry.time} is confirmed.`);
      processed++;
    } else if (action === "reject") {
      if (status !== PENDING_APPROVAL) {
        skipped++;
        errors.push({ code, reason: `Status is ${status}` });
        continue;
      }
      await prisma.queueEntry.update({ where: { code }, data: { status: "CANCELLED", cancelReason: reason } });
      await propagateToLinked(entry, "Rejected", auth.name);
      await notifyStudentByEmail({
        studentId: entry.studentId,
        name: entry.name,
        title: "Booking Not Approved",
        message: `Your appointment request ${code} (${serviceLabel(entry.serviceType)}) on ${entry.dateLabel} at ${entry.time} was not approved.${reason ? ` Reason: ${reason}` : ""} Please book another slot if you still need assistance.`,
        ref: code,
      });
      await addNotification(entry.studentId, "Booking Not Approved", `Your appointment request ${code} on ${entry.dateLabel} was not approved.${reason ? ` Reason: ${reason}` : ""}`);
      processed++;
    } else if (action === "checkin") {
      if (!["BOOKED", "RESCHEDULED"].includes(status)) {
        skipped++;
        errors.push({ code, reason: `Status is ${status}` });
        continue;
      }
      await prisma.queueEntry.update({ where: { code }, data: { status: "CHECKED_IN" } });
      await propagateToLinked(entry, "Checked In", auth.name);
      processed++;
    } else if (action === "serve") {
      if (["SERVED", "CANCELLED", "NO_SHOW", PENDING_APPROVAL].includes(status)) {
        skipped++;
        errors.push({ code, reason: `Status is ${status}` });
        continue;
      }
      await prisma.queueEntry.update({ where: { code }, data: { status: "SERVED", served: true } });
      await propagateToLinked(entry, "Completed", auth.name);
      processed++;
    } else if (action === "noshow") {
      if (["SERVED", "CANCELLED", "NO_SHOW", PENDING_APPROVAL].includes(status)) {
        skipped++;
        errors.push({ code, reason: `Status is ${status}` });
        continue;
      }
      await prisma.queueEntry.update({ where: { code }, data: { status: "NO_SHOW" } });
      await addNotification(entry.studentId, "Missed Appointment", `You missed your appointment ${code} on ${entry.dateLabel} at ${entry.time}. Please book a new slot if you still need assistance.`);
      await propagateToLinked(entry, "No Show", auth.name);
      processed++;
    }
  }

  await addAudit("INFO", `Batch appointment action "${action}" by ${auth.name}: ${processed} updated, ${skipped} skipped.`);
  return NextResponse.json({ ok: true, processed, skipped, errors });
}
