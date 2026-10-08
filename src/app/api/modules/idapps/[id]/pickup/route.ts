import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { pushRequestHistory } from "@/lib/service-requests";

/**
 * Pickup leg for ID Application (spec §2):
 * admin sets the pickup schedule when the ID is ready, the student is
 * notified, and claiming completes the application.
 *
 * Body schedule: { pickupDate, pickupTime, pickupNote? }
 * Body complete: { action: "complete" }
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.idApplication.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Application not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  if ((body?.action || "").toString().toLowerCase() === "complete") {
    if (!["Ready for Claiming", "Processing", "Approved"].includes(existing.status)) {
      return jsonError(409, `This application is ${existing.status} and cannot be marked as claimed.`, "INVALID_STATUS");
    }
    const history = pushRequestHistory(existing.history, { status: "Claimed", by: auth.name, note: "Picked up" });
    const updated = await prisma.idApplication.update({
      where: { id },
      data: { status: "Claimed", pickedUpAt: new Date(), history },
    });
    await addAudit("INFO", `ID app ${id} claimed — recorded by ${auth.name}.`);
    await notifyStudentByEmail({
      studentId: existing.sn,
      name: existing.name,
      title: "Student ID — Claimed",
      message: `Your ${existing.type} application (${id}) has been completed. Thank you!`,
      ref: id,
    });
    await addNotification(existing.sn, "ID Application Claimed", `Your ${existing.type} (${id}) is now: Claimed.`);
    return NextResponse.json(withTs(updated));
  }

  const pickupDate = (body?.pickupDate || "").toString().trim();
  const pickupTime = (body?.pickupTime || "").toString().trim();
  const pickupNote = (body?.pickupNote || "").toString().trim().slice(0, 500);
  if (!pickupDate || !pickupTime) {
    return jsonError(400, "Please provide a pickup date and time.", "MISSING_FIELDS");
  }
  if (!["Approved", "Processing", "Ready for Claiming"].includes(existing.status)) {
    return jsonError(
      409,
      `Pickup can only be scheduled once the application is approved and ready (current: ${existing.status}).`,
      "INVALID_STATUS"
    );
  }

  const history = pushRequestHistory(existing.history, {
    status: "Ready for Claiming",
    by: auth.name,
    note: `${pickupDate} ${pickupTime}`.trim(),
  });
  const updated = await prisma.idApplication.update({
    where: { id },
    data: { pickupDate, pickupTime, pickupNote, status: "Ready for Claiming", history },
  });

  await addAudit("INFO", `ID app ${id} pickup scheduled (${pickupDate} ${pickupTime}) by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: "Student ID — Ready for Claiming",
    message: `Your ID is ready! Please claim it at the SSO on ${pickupDate} at ${pickupTime}. Bring one valid ID.${pickupNote ? `\n\nNote: ${pickupNote}` : ""}`,
    ref: id,
  });
  await addNotification(existing.sn, "ID Ready for Claiming", `Your ${existing.type} is ready for pickup on ${pickupDate} at ${pickupTime}.`);

  return NextResponse.json(withTs(updated));
}
