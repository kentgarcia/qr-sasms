import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { normSN } from "@/lib/format";
import {
  ACTIVE_STATUSES,
  APPOINTMENT_SERVICES,
  PENDING_APPROVAL,
  dateISOPHT,
  getScheduleSettings,
  isKnownService,
  manilaDateParts,
  nextAppointmentCode,
  serializeAppointment,
  serviceLabel,
  withSlotLock,
} from "@/lib/appointments";

function todayManilaDateLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function nowManilaTimeLabel(): string {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * GET /api/queue/walkin?q=<student number or name>
 * Fast student lookup across registered Users and MasterlistEntry for staff-assisted walk-ins.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  const todayLabel = todayManilaDateLabel();
  const settings = await getScheduleSettings();

  if (!q) {
    return NextResponse.json({
      todayLabel,
      currentTime: nowManilaTimeLabel(),
      hours: settings.hours,
      services: Object.entries(APPOINTMENT_SERVICES).map(([key, def]) => ({ key, label: def.label })),
      matches: [],
    });
  }

  const [users, masterRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        role: "STUDENT",
        OR: [
          { studentId: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { studentId: true, name: true, email: true, course: true, year: true },
      take: 10,
    }),
    prisma.masterlistEntry.findMany({
      where: {
        OR: [
          { sn: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { sn: true, name: true, email: true, course: true, year: true },
      take: 10,
    }),
  ]);

  const seen = new Map<string, { studentId: string; name: string; email: string; course: string; year: string; registered: boolean }>();
  for (const u of users) {
    if (!u.studentId) continue;
    const sn = normSN(u.studentId);
    seen.set(sn, {
      studentId: sn,
      name: u.name || "",
      email: u.email || "",
      course: u.course || "",
      year: u.year || "",
      registered: true,
    });
  }
  for (const m of masterRows) {
    const sn = normSN(m.sn);
    if (!seen.has(sn)) {
      seen.set(sn, {
        studentId: sn,
        name: m.name || "",
        email: m.email || "",
        course: m.course || "",
        year: m.year || "",
        registered: false,
      });
    }
  }

  return NextResponse.json({
    todayLabel,
    currentTime: nowManilaTimeLabel(),
    hours: settings.hours,
    services: Object.entries(APPOINTMENT_SERVICES).map(([key, def]) => ({ key, label: def.label })),
    matches: [...seen.values()].slice(0, 12),
  });
}

/**
 * POST /api/queue/walkin
 * Issue an express / walk-in queue ticket on behalf of a student right at the Service Desk.
 * Roles: admin, super_admin, scanner.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin", "scanner"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const rawSn = String(body?.studentId || "").trim();
  const providedName = String(body?.name || "").trim().slice(0, 120);
  const service = String(body?.service || "GENERAL").trim().toUpperCase();
  const purpose = String(body?.purpose || "").trim().slice(0, 200);
  const notes = String(body?.notes || "").trim().slice(0, 500);
  const autoCheckIn = body?.autoCheckIn !== false; // default true for walk-ins

  if (!rawSn) return jsonError(400, "Please enter or select a student number.", "MISSING_FIELDS");
  if (!isKnownService(service)) return jsonError(400, `Unknown service "${service}".`, "SERVICE_NOT_OFFERED");

  const sn = normSN(rawSn);
  const [user, master] = await Promise.all([
    prisma.user.findFirst({ where: { studentId: sn, role: "STUDENT" }, select: { studentId: true, name: true, email: true } }),
    prisma.masterlistEntry.findFirst({ where: { sn }, select: { sn: true, name: true, email: true } }),
  ]);

  const studentName = user?.name || master?.name || providedName;
  if (!studentName) {
    return jsonError(400, "Student not found in directory or masterlist. Provide the student's full name to issue a walk-in pass.", "STUDENT_NOT_FOUND");
  }

  const todayParts = manilaDateParts(new Date());
  const dateLabel = todayManilaDateLabel();
  const dateISO = `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-${String(todayParts.day).padStart(2, "0")}` || dateISOPHT(dateLabel);
  const time = String(body?.time || "").trim() || `Walk-In (${nowManilaTimeLabel()})`;
  const now = new Date();
  const durationMin = APPOINTMENT_SERVICES[service]?.durationMin || 15;
  const slotEnd = new Date(now.getTime() + durationMin * 60_000);

  try {
    const result = await withSlotLock(`walkin:${dateISO}:${sn}`, async (tx) => {
      const existing = await tx.queueEntry.findFirst({
        where: {
          dateLabel,
          studentId: sn,
          status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] },
        },
      });
      if (existing) {
        return { conflict: existing as typeof existing, created: null };
      }

      const code = await nextAppointmentCode(tx);
      const entry = await tx.queueEntry.create({
        data: {
          code,
          studentId: sn,
          name: studentName,
          time,
          dateLabel,
          served: false,
          serviceType: service,
          status: autoCheckIn ? "CHECKED_IN" : "BOOKED",
          dateISO,
          slotStartAt: now,
          slotEndAt: slotEnd,
          bookedBy: `${auth.name} (Walk-In)`,
          purpose: purpose || "Express Walk-In Visit",
          notes: notes || "Issued at SSO Service Desk (Walk-In)",
        },
      });
      return { conflict: null, created: entry };
    });

    if (result.conflict) {
      return NextResponse.json(
        {
          error: `${studentName} (${sn}) already has active appointment ${result.conflict.code} today (${result.conflict.time}).`,
          code: "ALREADY_HAS_APPOINTMENT",
          existing: serializeAppointment(result.conflict),
        },
        { status: 409 }
      );
    }

    const created = result.created!;
    const label = serviceLabel(service);
    const discreet = service === "PSYCH";
    await addAudit(
      "INFO",
      discreet
        ? `Walk-in pass ${created.code} issued (${autoCheckIn ? "checked in" : "booked"}) by ${auth.name}.`
        : `Walk-in pass ${created.code} (${label}) issued for ${studentName} (${sn}) by ${auth.name}.`
    );

    if (user?.studentId) {
      await addNotification(
        sn,
        "Walk-In Queue Issued",
        `Service Desk issued walk-in ticket ${created.code} (${label}) for today (${time}).`
      );
      await notifyStudentByEmail({
        studentId: sn,
        name: studentName,
        title: `Walk-In Queue Pass — ${created.code}`,
        message: `You have been registered for an express walk-in visit (${created.code} — ${label}) today at ${time}. Please wait for your number to be called at the SSO.`,
        ref: created.code,
        qrAppointment: {
          code: created.code,
          studentId: sn,
          dateISO,
          dateLabel,
          time,
          serviceLabel: label,
        },
      });
    }

    return NextResponse.json({ ok: true, appointment: serializeAppointment(created) }, { status: 201 });
  } catch (err: unknown) {
    if (typeof err === "object" && err && "code" in err && (err as { code: string }).code === "P2002") {
      return jsonError(409, "This student already has an active appointment today.", "ALREADY_HAS_APPOINTMENT");
    }
    throw err;
  }
}
