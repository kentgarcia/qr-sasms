import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTs, withTsList } from "@/lib/format";
import {
  ACTIVE_STATUSES,
  OCCUPIED_STATUSES,
  PENDING_APPROVAL,
  APPOINTMENT_SERVICES,
  dateISOPHT,
  getScheduleSettings,
  getServiceConfigs,
  parseSlotStart,
  serviceOfferedOn,
  slotCapacity,
  validAppointmentDate,
  withSlotLock,
} from "@/lib/appointments";
import {
  SERVICE_REQUEST_SERVICES,
  isKnownRequestService,
  requestServiceLabel,
} from "@/lib/service-requests";

const GENERAL_CAP = "GENERAL";

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const service = (req.nextUrl.searchParams.get("service") || "").toUpperCase();
  if (service && !isKnownRequestService(service)) {
    return jsonError(400, "Unknown service.", "SERVICE_NOT_OFFERED");
  }
  const where: Record<string, unknown> = {};
  if (auth.role !== "admin" && auth.role !== "super_admin") {
    where.sn = auth.studentId || "";
  }
  if (service) where.service = service;
  const rows = await prisma.serviceRequest.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const service = (body?.service || "").toString().toUpperCase();
  if (!isKnownRequestService(service)) {
    return jsonError(400, "Please choose a service: Authentication, Excuse Slip, or General Visit.", "UNKNOWN_SERVICE");
  }
  const def = SERVICE_REQUEST_SERVICES[service];
  const subject = (body?.subject || body?.purpose || "").toString().trim().slice(0, 200);
  const details = (body?.details || body?.reason || "").toString().trim().slice(0, 2000);
  const copies = Math.max(1, Math.min(10, parseInt(body?.copies, 10) || 1));
  const docName = (body?.docName || "").toString();
  const docUrl = (body?.docUrl || "").toString() || null;

  if (!details) return jsonError(400, "Please provide the reason/details.", "MISSING_FIELDS");
  if (!def.pickup && !subject) {
    return jsonError(400, "Please provide a subject/purpose for your visit.", "MISSING_FIELDS");
  }

  // General Visit: schedule is part of the request (spec §5).
  const dateLabel = (body?.dateLabel || "").toString();
  const time = (body?.time || "").toString();
  if (def.appointment) {
    if (!dateLabel || !time) {
      return jsonError(400, "Please choose an available date and time for your visit.", "MISSING_FIELDS");
    }
    if (!validAppointmentDate(dateLabel)) {
      return jsonError(400, "Please choose a future weekday within the current or next month.", "INVALID_APPOINTMENT_DATE");
    }
    const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
    if (!settings.hours.includes(time)) {
      return jsonError(400, "Please choose a valid business-hours time slot.", "INVALID_TIME_SLOT");
    }
    const holiday = settings.holidays.find((h) => h.date === dateLabel);
    if (holiday) {
      return jsonError(400, `The SSO is closed on the selected date${holiday.name ? ` (${holiday.name})` : ""}.`, "HOLIDAY");
    }
    if (!serviceOfferedOn(GENERAL_CAP, dateLabel, configs)) {
      return jsonError(400, "General Visit is not offered on the selected day.", "SERVICE_NOT_OFFERED");
    }
    const slotStart = parseSlotStart(dateLabel, time);
    if (!slotStart) return jsonError(400, "Please choose a valid date and time slot.", "INVALID_APPOINTMENT");
    const capacity = slotCapacity(GENERAL_CAP, configs, settings.capacity);
    const durationMin = Math.max(5, configs[GENERAL_CAP]?.durationMin || APPOINTMENT_SERVICES[GENERAL_CAP].durationMin);
    const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
    const studentId = auth.studentId || "";
    const studentName = auth.name;

    try {
      const { request } = await withSlotLock(`slot:${GENERAL_CAP}:${dateLabel}:${time}`, async (tx) => {
        const existingBooking = await tx.queueEntry.findFirst({
          where: { dateLabel, studentId, status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] } },
        });
        if (existingBooking) {
          throw Object.assign(
            new Error(`You already have appointment ${existingBooking.code} on ${dateLabel}.`),
            { statusCode: 409, code: "ONE_APPOINTMENT_PER_DATE" }
          );
        }
        const taken = await tx.queueEntry.count({
          where: { dateLabel, time, serviceType: GENERAL_CAP, status: { in: OCCUPIED_STATUSES } },
        });
        if (taken >= capacity) {
          throw Object.assign(new Error("That time slot was just booked. Please choose another available time."), {
            statusCode: 409,
            code: "TIME_SLOT_TAKEN",
          });
        }
        const id = genId(def.prefix);
        const created = await tx.serviceRequest.create({
          data: {
            id,
            sn: studentId,
            name: studentName,
            service,
            subject,
            details,
            copies,
            docName,
            docUrl,
            status: "Pending Review",
            remarks: "",
            history: [{ ts: fnow(), status: "Pending Review", by: studentName }],
            dateLabel,
            time,
            slotStartAt: slotStart,
          },
        });
        const base = await tx.queueEntry.count({ where: { status: { not: "CANCELLED" } } });
        let n = base + 1;
        let code = "";
        for (let i = 0; i < 1000; i++) {
          code = `APT-${String(n).padStart(3, "0")}`;
          const clash = await tx.queueEntry.findUnique({ where: { code } });
          if (!clash) break;
          n++;
        }
        const appointment = await tx.queueEntry.create({
          data: {
            code,
            studentId,
            name: studentName,
            time,
            dateLabel,
            served: false,
            serviceType: GENERAL_CAP,
            serviceRefId: id,
            status: PENDING_APPROVAL,
            dateISO: dateISOPHT(dateLabel),
            slotStartAt: slotStart,
            slotEndAt: slotEnd,
            purpose: subject,
            copies,
            notes: details.slice(0, 500),
          },
        });
        await tx.serviceRequest.update({ where: { id }, data: { appointmentCode: code } });
        return { request: { ...created, appointmentCode: code } };
      });

      await addAudit("INFO", `General Visit request ${request.id} + appointment ${request.appointmentCode} submitted by ${studentName} (awaiting approval).`);
      await addNotification("admin", "New General Visit Request", `${studentName} requested a General Visit on ${dateLabel} at ${time} — awaiting approval.`);
      return NextResponse.json(withTs(request), { status: 201 });
    } catch (error: unknown) {
      if (typeof error === "object" && error && "statusCode" in error && "code" in error) {
        const e = error as { statusCode: number; code: string; message: string };
        return jsonError(e.statusCode, e.message, e.code);
      }
      throw error;
    }
  }

  // Authentication / Excuse Slip: request only, no appointment (spec §2).
  const created = await prisma.serviceRequest.create({
    data: {
      id: genId(def.prefix),
      sn: auth.studentId || "",
      name: auth.name,
      service,
      subject,
      details,
      copies,
      docName,
      docUrl,
      status: "Pending Review",
      remarks: "",
      history: [{ ts: fnow(), status: "Pending Review", by: auth.name }],
    },
  });

  await addAudit("INFO", `${requestServiceLabel(service)} request ${created.id} submitted by ${auth.name}.`);
  await addNotification("admin", `New ${requestServiceLabel(service)} Request`, `${auth.name} filed a ${requestServiceLabel(service)} request.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
