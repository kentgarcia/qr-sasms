import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import {
  ACTIVE_STATUSES,
  OCCUPIED_STATUSES,
  PENDING_APPROVAL,
  checkPrerequisite,
  dateISOPHT,
  getAvailability,
  getScheduleSettings,
  getServiceConfigs,
  isKnownService,
  listBookableLinks,
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

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (params.get("mine")) {
    const auth = await requireSession(["student"]);
    if (auth instanceof NextResponse) return auth;
    const settings = await getScheduleSettings();
    const withLeft = (rows: Array<Parameters<typeof serializeAppointment>[0]>) =>
      rows.map((r) => ({ ...serializeAppointment(r), reschedulesLeft: Math.max(0, settings.maxReschedules - (r.rescheduleCount || 0)), maxReschedules: settings.maxReschedules }));
    if (params.get("history")) {
      const rows = await prisma.queueEntry.findMany({
        where: { studentId: auth.studentId || "" },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return NextResponse.json(withLeft(rows));
    }
    const rows = await prisma.queueEntry.findMany({
      where: { studentId: auth.studentId || "", status: { in: [...ACTIVE_STATUSES, "PENDING"] } },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    return NextResponse.json(withLeft(rows));
  }

  if (params.get("links")) {
    const auth = await requireSession(["student"]);
    if (auth instanceof NextResponse) return auth;
    const service = (params.get("service") || "GENERAL").toUpperCase();
    if (!isKnownService(service)) return jsonError(400, "Unknown service.", "SERVICE_NOT_OFFERED");
    return NextResponse.json({
      service,
      serviceLabel: serviceLabel(service),
      linkedType: APPOINTMENT_SERVICES[service].linkedType,
      links: await listBookableLinks(service, auth.studentId || ""),
    });
  }

  const dateLabel = params.get("date");
  if (dateLabel) {
    const auth = await requireSession();
    if (auth instanceof NextResponse) return auth;
    const service = (params.get("service") || "").toUpperCase();
    const svc = service && isKnownService(service) ? service : undefined;
    const avail = await getAvailability(dateLabel, svc);
    const mine = await prisma.queueEntry.findFirst({
      where: { dateLabel, studentId: auth.studentId || "", status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] } },
      select: { code: true, time: true, serviceType: true, status: true },
    });
    const holiday = avail.settings.holidays.find((h) => h.date === dateLabel);
    return NextResponse.json({
      bookedTimes: avail.bookedTimes,
      myAppointment: mine
        ? { ...mine, status: normalizeStatus(mine.status), serviceLabel: serviceLabel(mine.serviceType) }
        : null,
      capacity: avail.capacity,
      slots: avail.slots,
      holiday: holiday || null,
    });
  }

  if (params.get("count")) {
    const auth = await requireSession();
    if (auth instanceof NextResponse) return auth;
    const count = await prisma.queueEntry.count({ where: { status: { not: "CANCELLED" } } });
    return NextResponse.json({ count });
  }

  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const where: Record<string, unknown> = { status: { not: "CANCELLED" } };
  const fDate = params.get("date");
  const fService = (params.get("service") || "").toUpperCase();
  const fStatus = (params.get("status") || "").toUpperCase();
  if (fDate) where.dateLabel = fDate;
  if (fService && isKnownService(fService)) where.serviceType = fService;
  if (fStatus) where.status = fStatus;
  const rows = await prisma.queueEntry.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map(serializeAppointment));
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["student", "admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const service = ((body?.service || "GENERAL").toString() || "GENERAL").toUpperCase();
  const dateLabel = (body?.dateLabel || "").toString();
  const time = (body?.time || "").toString();
  const linkedId = body?.linkedId != null ? String(body.linkedId) : null;
  const purpose = (body?.purpose || "").toString().slice(0, 200);
  const copies = Math.max(1, Math.min(10, parseInt(body?.copies, 10) || 1));
  const notes = (body?.notes || "").toString().slice(0, 500);
  if (!dateLabel || !time) return jsonError(400, "Please choose a date and time slot.", "MISSING_FIELDS");
  if (!isKnownService(service)) return jsonError(400, `Unknown service "${service}".`, "SERVICE_NOT_OFFERED");
  // Request-based services (spec §2) are never booked directly: the student
  // files a request and the SSO schedules a pickup when it is ready.
  if (APPOINTMENT_SERVICES[service]?.requestOnly) {
    return jsonError(
      409,
      `${serviceLabel(service)} visits cannot be booked directly. ${APPOINTMENT_SERVICES[service].prerequisiteHint}`,
      "REQUEST_FIRST"
    );
  }

  // Admin booking on behalf of a student.
  let studentId = auth.studentId || "";
  let studentName = auth.name;
  let bookedBy: string | null = null;
  if (auth.role === "admin" || auth.role === "super_admin") {
    if (body?.studentId) {
      const target = await prisma.user.findFirst({
        where: { studentId: String(body.studentId), role: "STUDENT" },
        select: { studentId: true, name: true },
      });
      if (!target?.studentId) return jsonError(404, "Student not found.", "STUDENT_NOT_FOUND");
      studentId = target.studentId;
      studentName = target.name;
      bookedBy = auth.name;
    } else if (!studentId) {
      return jsonError(400, "Provide studentId to book on behalf of a student.", "MISSING_FIELDS");
    }
  }

  if (!validAppointmentDate(dateLabel)) return jsonError(400, "Please choose a future weekday within the current or next month.", "INVALID_APPOINTMENT_DATE");
  const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
  if (!settings.hours.includes(time)) return jsonError(400, "Please choose a valid business-hours time slot.", "INVALID_TIME_SLOT");
  const holiday = settings.holidays.find((h) => h.date === dateLabel);
  if (holiday) return jsonError(400, `The SSO is closed on the selected date${holiday.name ? ` (${holiday.name})` : ""}.`, "HOLIDAY");
  if (!serviceOfferedOn(service, dateLabel, configs)) {
    return jsonError(400, `${serviceLabel(service)} is not offered on the selected day.`, "SERVICE_NOT_OFFERED");
  }

  const prereq = await checkPrerequisite(service, studentId, linkedId);
  if (!prereq.ok) return jsonError(409, prereq.error || "A linked request is required before booking.", prereq.code || "PREREQUISITE_MISSING");

  const slotStart = parseSlotStart(dateLabel, time);
  if (!slotStart) return jsonError(400, "Please choose a valid date and time slot.", "INVALID_APPOINTMENT");

  const capacity = slotCapacity(service, configs, settings.capacity);
  const durationMin = Math.max(5, configs[service]?.durationMin || APPOINTMENT_SERVICES[service].durationMin);
  const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
  const lockKey = `slot:${service}:${dateLabel}:${time}`;

  try {
    const created = await withSlotLock(lockKey, async (tx) => {
      const existingBooking = await tx.queueEntry.findFirst({
        where: { dateLabel, studentId, status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] } },
      });
      if (existingBooking) {
        throw Object.assign(new Error(`You already have appointment ${existingBooking.code} on ${dateLabel}.`), { statusCode: 409, code: "ONE_APPOINTMENT_PER_DATE" });
      }
      const taken = await tx.queueEntry.count({ where: { dateLabel, time, serviceType: service, status: { in: OCCUPIED_STATUSES } } });
      if (taken >= capacity) {
        throw Object.assign(new Error("That time slot was just booked. Please choose another available time."), { statusCode: 409, code: "TIME_SLOT_TAKEN" });
      }
      const base = await tx.queueEntry.count({ where: { status: { not: "CANCELLED" } } });
      let n = base + 1;
      let code = "";
      for (let i = 0; i < 1000; i++) {
        code = `APT-${String(n).padStart(3, "0")}`;
        const clash = await tx.queueEntry.findUnique({ where: { code } });
        if (!clash) break;
        n++;
      }
      let organizationId: string | null = null;
      if (prereq.linkedType === "EventRequest" && prereq.linkedId) {
        const evt = await tx.eventRequest.findUnique({ where: { id: prereq.linkedId }, select: { organizationId: true } });
        organizationId = evt?.organizationId || null;
      }
      return tx.queueEntry.create({
        data: {
          code, studentId, name: studentName, time, dateLabel, served: false,
          serviceType: service, serviceRefId: prereq.linkedId, organizationId,
          // Student bookings wait for SSO approval; staff bookings are confirmed.
          status: bookedBy ? "BOOKED" : PENDING_APPROVAL, dateISO: dateISOPHT(dateLabel),
          slotStartAt: slotStart, slotEndAt: slotEnd,
          bookedBy, purpose, copies, notes,
        },
      });
    });

    const label = serviceLabel(service);
    const refNote = prereq.linkedId ? ` (ref ${prereq.linkedId})` : "";
    const discreet = service === "PSYCH";
    const needsApproval = !bookedBy;
    await addNotification("admin", needsApproval ? "New Booking Request" : "New Appointment", `${studentName} ${needsApproval ? "requested" : "was booked for"} ${created.code} — ${label}${discreet ? "" : refNote}, ${dateLabel}, ${time}.${needsApproval ? " Awaiting approval." : ""}`);
    await addAudit("INFO", discreet
      ? `Psychological appointment ${needsApproval ? "requested" : "booked"} — ${created.code} for ${studentName} on ${dateLabel} at ${time}.`
      : `Appointment ${needsApproval ? "requested" : "booked"} — ${created.code} (${label}${refNote}) for ${studentName} on ${dateLabel} at ${time}.`);

    return NextResponse.json(serializeAppointment(created), { status: 201 });
  } catch (error: unknown) {
    if (typeof error === "object" && error) {
      if ("statusCode" in error && "code" in error) {
        const e = error as { statusCode: number; code: string; message: string };
        return jsonError(e.statusCode, e.message, e.code);
      }
      if ("code" in error && (error as { code: string }).code === "P2002") {
        return jsonError(409, "This appointment or time slot was just booked. Please choose another time.", "BOOKING_CONFLICT");
      }
    }
    throw error;
  }
}
