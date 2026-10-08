import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import {
  ACTIVE_STATUSES,
  OCCUPIED_STATUSES,
  PENDING_APPROVAL,
  PRE_VISIT_STATUSES,
  getScheduleSettings,
  getServiceConfigs,
  normalizeStatus,
  parseSlotStart,
  serializeAppointment,
  serviceLabel,
  slotCapacity,
  serviceOfferedOn,
  validAppointmentDate,
  withSlotLock,
  APPOINTMENT_SERVICES,
} from "@/lib/appointments";

export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const dateLabel = String(body?.dateLabel || "");
  const time = String(body?.time || "");
  const code = decodeURIComponent(params.code);
  const entry = await prisma.queueEntry.findFirst({ where: { code, studentId: auth.studentId || "" } });
  if (!entry) {
    return jsonError(404, "Active appointment not found.", "NOT_FOUND");
  }
  if (normalizeStatus(entry.status) === PENDING_APPROVAL) {
    return jsonError(409, "This booking is still awaiting SSO approval — cancel it and book a new slot if plans changed.", "PENDING_APPROVAL");
  }
  if (!PRE_VISIT_STATUSES.includes(normalizeStatus(entry.status))) {
    return jsonError(404, "Active appointment not found.", "NOT_FOUND");
  }
  const service = entry.serviceType;
  const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
  if (
    !validAppointmentDate(dateLabel) ||
    !settings.hours.includes(time) ||
    settings.holidays.some((h) => h.date === dateLabel) ||
    !serviceOfferedOn(service, dateLabel, configs)
  ) {
    return jsonError(400, "Select an available business day and time.", "INVALID_APPOINTMENT");
  }
  const cutoff = settings.cutoffHours;
  const currentStart = parseSlotStart(entry.dateLabel, entry.time);
  if (currentStart && currentStart.getTime() - Date.now() < cutoff * 3600000) {
    return jsonError(409, `Appointments can only be rescheduled at least ${cutoff} hours before the scheduled time.`, "CUTOFF_PASSED");
  }
  const usedReschedules = entry.rescheduleCount || 0;
  if (usedReschedules >= settings.maxReschedules) {
    return jsonError(409, `This appointment has already been rescheduled ${usedReschedules} time${usedReschedules === 1 ? "" : "s"} (limit: ${settings.maxReschedules}). Please cancel and book a new appointment if needed.`, "RESCHEDULE_LIMIT_REACHED");
  }
  const capacity = slotCapacity(service, configs, settings.capacity);
  const durationMin = Math.max(5, configs[service]?.durationMin || APPOINTMENT_SERVICES[service]?.durationMin || 10);
  const slotStart = parseSlotStart(dateLabel, time);
  if (!slotStart) return jsonError(400, "Select an available business day and time.", "INVALID_APPOINTMENT");

  try {
    const updated = await withSlotLock(`slot:${service}:${dateLabel}:${time}`, async (tx) => {
      const clash = await tx.queueEntry.findFirst({
        where: { dateLabel, studentId: auth.studentId || "", status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] }, NOT: { code } },
        select: { code: true },
      });
      if (clash) {
        throw Object.assign(new Error("You already have an appointment on that date."), { statusCode: 409, code: "ONE_APPOINTMENT_PER_DATE" });
      }
      const taken = await tx.queueEntry.count({ where: { dateLabel, time, serviceType: service, status: { in: OCCUPIED_STATUSES }, NOT: { code } } });
      if (taken >= capacity) {
        throw Object.assign(new Error("That time slot is full."), { statusCode: 409, code: "TIME_SLOT_TAKEN" });
      }
      return tx.queueEntry.update({
        where: { code },
        data: {
          dateLabel, time, status: "RESCHEDULED",
          slotStartAt: slotStart, slotEndAt: new Date(slotStart.getTime() + durationMin * 60000),
          rescheduleCount: { increment: 1 },
        },
      });
    });
    const discreet = service === "PSYCH";
    await addAudit("INFO", discreet
      ? `${code} rescheduled by ${auth.name} to ${dateLabel} ${time}.`
      : `${code} (${serviceLabel(service)}) rescheduled by ${auth.name} to ${dateLabel} ${time}.`);
    await addNotification("admin", "Appointment Rescheduled", `${auth.name} rescheduled ${code} to ${dateLabel}, ${time}.`);
    return NextResponse.json(serializeAppointment(updated));
  } catch (error: unknown) {
    if (typeof error === "object" && error && "statusCode" in error && "code" in error) {
      const e = error as { statusCode: number; code: string; message: string };
      return jsonError(e.statusCode, e.message, e.code);
    }
    if (typeof error === "object" && error && "code" in error && (error as { code: string }).code === "P2002") {
      return jsonError(409, "You already have an appointment on that date.", "ONE_APPOINTMENT_PER_DATE");
    }
    throw error;
  }
}
