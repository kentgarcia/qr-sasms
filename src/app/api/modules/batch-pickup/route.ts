import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { pushRequestHistory, requestServiceLabel } from "@/lib/service-requests";
import { upsertPickupQueueEntry } from "@/lib/appointments";

/**
 * POST /api/modules/batch-pickup
 * Batch schedule pickups for multiple Service Requests (Authentication / Excuse Slip)
 * or ID Applications in one step.
 * Body: { kind: "requests" | "idapps", ids: string[], pickupDate: string, pickupTime: string, pickupNote?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind || "").toLowerCase();
  const rawIds = Array.isArray(body?.ids) ? body.ids : [];
  const pickupDate = String(body?.pickupDate || "").trim();
  const pickupTime = String(body?.pickupTime || "").trim();
  const pickupNote = String(body?.pickupNote || "").trim().slice(0, 500);

  if (kind !== "requests" && kind !== "idapps") {
    return jsonError(400, "Kind must be 'requests' or 'idapps'.", "INVALID_KIND");
  }
  if (!pickupDate || !pickupTime) {
    return jsonError(400, "Please provide a pickup date and time.", "MISSING_FIELDS");
  }

  const ids: string[] = Array.from(
    new Set<string>(rawIds.map((x: unknown) => String(x || "").trim()).filter(Boolean))
  ).slice(0, 100);
  if (!ids.length) {
    return jsonError(400, "Select at least one eligible record.", "MISSING_FIELDS");
  }

  let processed = 0;
  let skipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  if (kind === "requests") {
    const rows = await prisma.serviceRequest.findMany({ where: { id: { in: ids } } });
    skipped += ids.length - rows.length;

    for (const existing of rows) {
      if (existing.service === "GENERAL_VISIT") {
        skipped++;
        errors.push({ id: existing.id, reason: "General Visit does not use pickup scheduling" });
        continue;
      }
      if (!["Approved", "Ready for Pickup", "Pickup Scheduled"].includes(existing.status)) {
        skipped++;
        errors.push({ id: existing.id, reason: `Status is ${existing.status}` });
        continue;
      }

      const label = requestServiceLabel(existing.service);
      const serviceKey = existing.service === "EXCUSE_SLIP" ? "EXCUSE" : "AUTH";
      const { queueEntry } = await prisma.$transaction(async (tx) => {
        const qe = await upsertPickupQueueEntry(tx, {
          service: serviceKey,
          linkedId: existing.id,
          studentId: existing.sn,
          studentName: existing.name,
          pickupDate,
          pickupTime,
          pickupNote,
          bookedBy: auth.name,
        });
        const history = pushRequestHistory(existing.history, {
          status: "Pickup Scheduled",
          by: auth.name,
          note: `${pickupDate} ${pickupTime}${qe ? ` (${qe.code})` : ""} [Batch]`.trim(),
        });
        await tx.serviceRequest.update({
          where: { id: existing.id },
          data: {
            pickupDate,
            pickupTime,
            pickupNote,
            status: "Pickup Scheduled",
            ...(qe ? { appointmentCode: qe.code } : {}),
            history,
          },
        });
        return { queueEntry: qe };
      });

      await notifyStudentByEmail({
        studentId: existing.sn,
        name: existing.name,
        title: `${label} — Pickup Scheduled`,
        message: `Your ${label} request (${existing.id}) is ready! Please pick it up at the SSO on ${pickupDate} at ${pickupTime}.${queueEntry ? ` Appointment code: ${queueEntry.code}.` : ""}${pickupNote ? `\n\nNote: ${pickupNote}` : ""}`,
        ref: existing.id,
        qrAppointment: queueEntry
          ? {
              code: queueEntry.code,
              studentId: existing.sn,
              dateISO: queueEntry.dateISO || "",
              dateLabel: pickupDate,
              time: pickupTime,
              serviceLabel: `${label} Pickup`,
            }
          : null,
      });
      await addNotification(existing.sn, `${label} Pickup Scheduled`, `Your ${label} request is ready for pickup on ${pickupDate} at ${pickupTime}.`);
      processed++;
    }
  } else {
    const rows = await prisma.idApplication.findMany({ where: { id: { in: ids } } });
    skipped += ids.length - rows.length;

    for (const existing of rows) {
      if (!["Approved", "Processing", "Ready for Claiming"].includes(existing.status)) {
        skipped++;
        errors.push({ id: existing.id, reason: `Status is ${existing.status}` });
        continue;
      }

      const serviceKey = /lost/i.test(existing.type) ? "ID_LOST" : "ID_NEW";
      const { queueEntry } = await prisma.$transaction(async (tx) => {
        const qe = await upsertPickupQueueEntry(tx, {
          service: serviceKey,
          linkedId: existing.id,
          studentId: existing.sn,
          studentName: existing.name,
          pickupDate,
          pickupTime,
          pickupNote,
          bookedBy: auth.name,
        });
        const history = pushRequestHistory(existing.history, {
          status: "Ready for Claiming",
          by: auth.name,
          note: `${pickupDate} ${pickupTime}${qe ? ` (${qe.code})` : ""} [Batch]`.trim(),
        });
        await tx.idApplication.update({
          where: { id: existing.id },
          data: { pickupDate, pickupTime, pickupNote, status: "Ready for Claiming", history },
        });
        return { queueEntry: qe };
      });

      await notifyStudentByEmail({
        studentId: existing.sn,
        name: existing.name,
        title: "Student ID — Ready for Claiming",
        message: `Your ID is ready! Please claim it at the SSO on ${pickupDate} at ${pickupTime}. Bring one valid ID.${queueEntry ? ` Appointment code: ${queueEntry.code}.` : ""}${pickupNote ? `\n\nNote: ${pickupNote}` : ""}`,
        ref: existing.id,
        qrAppointment: queueEntry
          ? {
              code: queueEntry.code,
              studentId: existing.sn,
              dateISO: queueEntry.dateISO || "",
              dateLabel: pickupDate,
              time: pickupTime,
              serviceLabel: `${existing.type} Pickup`,
            }
          : null,
      });
      await addNotification(existing.sn, "ID Ready for Claiming", `Your ${existing.type} is ready for pickup on ${pickupDate} at ${pickupTime}.`);
      processed++;
    }
  }

  await addAudit("INFO", `Batch pickup scheduled (${kind}) for ${pickupDate} ${pickupTime} by ${auth.name}: ${processed} scheduled, ${skipped} skipped.`);
  return NextResponse.json({ ok: true, processed, skipped, errors });
}
