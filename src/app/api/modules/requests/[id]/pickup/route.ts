import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { pushRequestHistory, requestServiceLabel } from "@/lib/service-requests";

/**
 * Pickup leg for Authentication / Excuse Slip (spec §2):
 * admin sets the pickup schedule when the request is ready, the student is
 * notified, and pickup completes the request.
 *
 * Body schedule: { pickupDate, pickupTime, pickupNote? }
 * Body complete: { action: "complete" }
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Request not found.", "NOT_FOUND");
  if (existing.service === "GENERAL_VISIT") {
    return jsonError(400, "General Visit requests use appointments, not pickup scheduling.", "INVALID_SERVICE");
  }

  const body = await req.json().catch(() => ({}));
  const label = requestServiceLabel(existing.service);

  if ((body?.action || "").toString().toLowerCase() === "complete") {
    if (existing.status !== "Pickup Scheduled") {
      return jsonError(409, "Only requests with a scheduled pickup can be marked as picked up.", "INVALID_STATUS");
    }
    const history = pushRequestHistory(existing.history, { status: "Completed", by: auth.name, note: "Picked up" });
    const updated = await prisma.serviceRequest.update({
      where: { id },
      data: { status: "Completed", pickedUpAt: new Date(), history },
    });
    await addAudit("INFO", `${label} request ${id} picked up (completed) — recorded by ${auth.name}.`);
    await notifyStudentByEmail({
      studentId: existing.sn,
      name: existing.name,
      title: `${label} — Completed`,
      message: `Your ${label} request (${id}) has been completed. Thank you!`,
      ref: id,
    });
    await addNotification(existing.sn, `${label} Completed`, `Your ${label} request (${id}) is now: Completed.`);
    return NextResponse.json(withTs(updated));
  }

  const pickupDate = (body?.pickupDate || "").toString().trim();
  const pickupTime = (body?.pickupTime || "").toString().trim();
  const pickupNote = (body?.pickupNote || "").toString().trim().slice(0, 500);
  if (!pickupDate || !pickupTime) {
    return jsonError(400, "Please provide a pickup date and time.", "MISSING_FIELDS");
  }
  if (!["Approved", "Ready for Pickup", "Pickup Scheduled"].includes(existing.status)) {
    return jsonError(
      409,
      `Pickup can only be scheduled once the request is approved and ready (current: ${existing.status}).`,
      "INVALID_STATUS"
    );
  }

  const history = pushRequestHistory(existing.history, {
    status: "Pickup Scheduled",
    by: auth.name,
    note: `${pickupDate} ${pickupTime}`.trim(),
  });
  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: { pickupDate, pickupTime, pickupNote, status: "Pickup Scheduled", history },
  });

  await addAudit("INFO", `${label} request ${id} pickup scheduled (${pickupDate} ${pickupTime}) by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: `${label} — Pickup Scheduled`,
    message: `Your ${label} request (${id}) is ready! Please pick it up at the SSO on ${pickupDate} at ${pickupTime}.${pickupNote ? `\n\nNote: ${pickupNote}` : ""}`,
    ref: id,
  });
  await addNotification(existing.sn, `${label} Pickup Scheduled`, `Your ${label} request is ready for pickup on ${pickupDate} at ${pickupTime}.`);

  return NextResponse.json(withTs(updated));
}
