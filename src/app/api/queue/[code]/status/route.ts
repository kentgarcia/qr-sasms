import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { dateISOPHT, normalizeStatus, serializeAppointment, serviceLabel, PENDING_APPROVAL } from "@/lib/appointments";
import { propagateToLinked } from "@/lib/appointment-sync";

/**
 * Staff lifecycle transitions (spec §§6,7):
 *   approve | reject (pending bookings) → checkin → serve | noshow | cancel
 * Roles: admin / super_admin / scanner — except approve/reject, which are
 * admin-only (scanners serve the day queue but don't confirm bookings).
 *
 * Serving an appointment completes its linked General Visit request and
 * appends a visit note to linked Event / Referral / ID records (their own
 * completion stays admin-managed).
 */
export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const rawAction = String(body?.action || "").toLowerCase();
  const action = rawAction === "complete" ? "serve" : rawAction;
  const reason = (body?.reason || "").toString() || null;
  if (!["checkin", "serve", "noshow", "cancel", "approve", "reject"].includes(action)) {
    return jsonError(400, "Action must be checkin, serve, noshow, cancel, approve, or reject.", "INVALID_ACTION");
  }
  const code = decodeURIComponent(params.code);
  const entry = await prisma.queueEntry.findUnique({ where: { code } });
  if (!entry) return jsonError(404, "Appointment not found.", "NOT_FOUND");
  const status = normalizeStatus(entry.status);
  const discreet = entry.serviceType === "PSYCH";
  const detail = discreet ? code : `${code} (${serviceLabel(entry.serviceType)})`;

  if (action === "approve" || action === "reject") {
    if (auth.role !== "admin" && auth.role !== "super_admin") {
      return jsonError(403, "Only SSO admins may approve or reject bookings.", "FORBIDDEN");
    }
    if (status !== PENDING_APPROVAL) {
      return jsonError(409, `Only bookings awaiting approval can be ${action === "approve" ? "approved" : "rejected"} (current: ${status}).`, "INVALID_STATE");
    }
    if (action === "approve") {
      const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "BOOKED" } });
      await addAudit("INFO", `${detail} booking approved (confirmed) by ${auth.name}.`);
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
      return NextResponse.json(serializeAppointment(updated));
    }
    const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "CANCELLED", cancelReason: reason } });
    await addAudit("INFO", `${detail} booking rejected by ${auth.name}${reason ? `: ${reason}` : ""}.`);
    await propagateToLinked(entry, "Rejected", auth.name);
    await notifyStudentByEmail({
      studentId: entry.studentId,
      name: entry.name,
      title: "Booking Not Approved",
      message: `Your appointment request ${code} (${serviceLabel(entry.serviceType)}) on ${entry.dateLabel} at ${entry.time} was not approved.${reason ? ` Reason: ${reason}` : ""} Please book another slot if you still need assistance.`,
      ref: code,
    });
    await addNotification(entry.studentId, "Booking Not Approved", `Your appointment request ${code} on ${entry.dateLabel} was not approved.${reason ? ` Reason: ${reason}` : ""}`);
    return NextResponse.json(serializeAppointment(updated));
  }

  if (action === "checkin") {
    if (!["BOOKED", "RESCHEDULED"].includes(status)) return jsonError(409, `Cannot check in an appointment with status ${status}.`, "INVALID_STATE");
    const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "CHECKED_IN" } });
    await addAudit("INFO", `${detail} checked in by ${auth.name}.`);
    await propagateToLinked(entry, "Checked In", auth.name);
    return NextResponse.json(serializeAppointment(updated));
  }
  if (action === "serve") {
    if (["SERVED", "CANCELLED", "NO_SHOW", PENDING_APPROVAL].includes(status)) return jsonError(409, `Cannot serve an appointment with status ${status}.`, "INVALID_STATE");
    const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "SERVED", served: true } });
    await addAudit("INFO", `${detail} — ${entry.name} served by ${auth.name}.`);
    await propagateToLinked(entry, "Completed", auth.name);
    return NextResponse.json(serializeAppointment(updated));
  }
  if (action === "noshow") {
    if (["SERVED", "CANCELLED", "NO_SHOW", PENDING_APPROVAL].includes(status)) return jsonError(409, `Cannot mark an appointment with status ${status} as no-show.`, "INVALID_STATE");
    const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "NO_SHOW" } });
    await addAudit("INFO", `${detail} marked as no-show by ${auth.name}.`);
    await addNotification(entry.studentId, "Missed Appointment", `You missed your appointment ${code} on ${entry.dateLabel} at ${entry.time}. Please book a new slot if you still need assistance.`);
    await propagateToLinked(entry, "No Show", auth.name);
    return NextResponse.json(serializeAppointment(updated));
  }
  // staff cancel
  if (["SERVED", "CANCELLED", "NO_SHOW"].includes(status)) return jsonError(409, `Cannot cancel an appointment with status ${status}.`, "INVALID_STATE");
  const updated = await prisma.queueEntry.update({ where: { code }, data: { status: "CANCELLED", cancelReason: reason } });
  await addAudit("INFO", `${detail} cancelled by staff ${auth.name}${reason ? `: ${reason}` : ""}.`);
  await addNotification(entry.studentId, "Appointment Cancelled by SSO", `Your appointment ${code} on ${entry.dateLabel} at ${entry.time} was cancelled by the SSO.${reason ? ` Reason: ${reason}` : ""} Please book a new slot.`);
  await propagateToLinked(entry, "Cancelled", auth.name);
  return NextResponse.json(serializeAppointment(updated));
}
