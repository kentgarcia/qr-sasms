import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTsList, withTs } from "@/lib/format";
import {
  createLinkedAppointment,
  validateSlotForBooking,
  withSlotLock,
} from "@/lib/appointments";


export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.referral.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString();
  const details = (body?.details || "").toString().trim();
  if (!details) return jsonError(400, "Please describe your concern.", "MISSING_FIELDS");

  // Optional schedule chosen as part of the request (spec §4).
  const appointmentDate = (body?.appointmentDate || body?.appointmentDateLabel || "").toString();
  const appointmentTime = (body?.appointmentTime || "").toString();
  if (appointmentDate || appointmentTime) {
    if (!appointmentDate || !appointmentTime) {
      return jsonError(400, "Please choose both an appointment date and time, or neither.", "MISSING_FIELDS");
    }
    let slot;
    try {
      slot = await validateSlotForBooking("PSYCH", appointmentDate, appointmentTime);
    } catch (error: unknown) {
      const e = error as { statusCode?: number; code?: string; message?: string };
      return jsonError(e.statusCode || 400, e.message || "Invalid appointment slot.", e.code || "INVALID_APPOINTMENT");
    }
    try {
      const created = await withSlotLock(`slot:PSYCH:${appointmentDate}:${appointmentTime}`, async (tx) => {
        const id = genId("REF");
        const ref = await tx.referral.create({
          data: {
            id,
            sn: auth.studentId || "",
            name: auth.name,
            category,
            details,
            status: "Pending",
            remarks: "",
            history: [{ ts: fnow(), status: "Pending", by: auth.name }],
            appointmentDate,
            appointmentTime,
          },
        });
        // Details are confidential: audit/notification carry the code only (spec §4).
        const appointment = await createLinkedAppointment(tx, {
          service: "PSYCH",
          studentId: auth.studentId || "",
          studentName: auth.name,
          dateLabel: appointmentDate,
          time: appointmentTime,
          slotStart: slot.slotStart,
          slotEnd: slot.slotEnd,
          capacity: slot.capacity,
          linkedId: id,
        });
        return tx.referral.update({ where: { id: ref.id }, data: { appointmentCode: appointment.code } });
      });

      await addAudit("INFO", `Psychological intervention request ${created.id} + confidential appointment ${created.appointmentCode} submitted.`);
      await addNotification("admin", "New Referral", `${auth.name} filed a ${category} referral with appointment ${created.appointmentCode}.`);

      return NextResponse.json(withTs(created), { status: 201 });
    } catch (error: unknown) {
      const e = error as { statusCode?: number; code?: string; message?: string };
      if (e.statusCode && e.code) return jsonError(e.statusCode, e.message || "Booking failed.", e.code);
      throw error;
    }
  }

  const created = await prisma.referral.create({
    data: {
      id: genId("REF"),
      sn: auth.studentId || "",
      name: auth.name,
      category,
      details,
      status: "Pending",
      remarks: "",
      history: [{ ts: fnow(), status: "Pending", by: auth.name }],
    },
  });

  await addAudit("INFO", `Referral submitted by ${auth.name} (${category}).`);
  await addNotification("admin", "New Referral", `${auth.name} filed a ${category} referral.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
