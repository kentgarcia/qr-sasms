import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { normalizeStatus, serializeAppointment, serviceLabel, PENDING_APPROVAL } from "@/lib/appointments";
import { pushRequestHistory } from "@/lib/service-requests";
import { fnow } from "@/lib/format";
import type { Prisma as PrismaTypes } from "@prisma/client";

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

type QueueRow = {
  code: string;
  studentId: string;
  name: string;
  serviceType: string;
  serviceRefId: string | null;
  dateLabel: string;
  time: string;
};

/**
 * Mirror a visit event onto the linked request record. Never throws —
 * the appointment transition must not fail because of propagation.
 */
async function propagateToLinked(entry: QueueRow, visitStatus: string, by: string) {
  if (!entry.serviceRefId) return;
  try {
    if (entry.serviceType === "GENERAL") {
      const linked = await prisma.serviceRequest.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      if (visitStatus === "Completed") {
        if (["Completed", "Cancelled", "No Show", "Rejected"].includes(linked.status)) return;
        const history = pushRequestHistory(linked.history, { status: "Completed", by, note: `Visit ${entry.code} served` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { status: "Completed", history } });
        await notifyStudentByEmail({
          studentId: linked.sn,
          name: linked.name,
          title: "General Visit — Completed",
          message: `Your General Visit (${linked.id}, appointment ${entry.code}) has been completed. Thank you!`,
          ref: linked.id,
        });
        await addNotification(linked.sn, "General Visit Completed", `Your General Visit (${linked.id}) is now: Completed.`);
      } else if (visitStatus === "No Show") {
        if (["Completed", "Cancelled", "No Show", "Rejected"].includes(linked.status)) return;
        const history = pushRequestHistory(linked.history, { status: "No Show", by, note: `Missed appointment ${entry.code}` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { status: "No Show", history } });
      } else {
        const history = pushRequestHistory(linked.history, { status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { history } });
      }
      return;
    }
    if (entry.serviceType === "EVENT") {
      const linked = await prisma.eventRequest.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const history = Array.isArray(linked.history) ? ([...linked.history] as PrismaTypes.JsonArray) : [];
      history.push({ ts: fnow(), status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      await prisma.eventRequest.update({ where: { id: linked.id }, data: { history } });
      return;
    }
    if (entry.serviceType === "PSYCH") {
      const linked = await prisma.referral.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const history = Array.isArray(linked.history) ? ([...linked.history] as PrismaTypes.JsonArray) : [];
      history.push({ ts: fnow(), status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      await prisma.referral.update({ where: { id: linked.id }, data: { history } });
      return;
    }
    if (entry.serviceType === "ID_NEW" || entry.serviceType === "ID_LOST") {
      const linked = await prisma.idApplication.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const history = pushRequestHistory(linked.history, { status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      await prisma.idApplication.update({ where: { id: linked.id }, data: { history } });
    }
  } catch {
    // Propagation is best-effort; the appointment transition already succeeded.
  }
}
