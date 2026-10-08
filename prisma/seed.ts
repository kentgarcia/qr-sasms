import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

/** Parse "September 26, 2026" + "8:00 AM" into a Date at Asia/Manila (+08:00). Mirrors src/lib/appointments.ts. */
function parseSlotStart(dateLabel: string, time: string): Date | null {
  const probe = new Date(`${dateLabel} 12:00:00`);
  if (Number.isNaN(probe.getTime())) return null;
  const normalized = probe.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (normalized !== dateLabel) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(time);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (hh < 1 || hh > 12 || mm > 59) return null;
  if (ap === "AM") hh = hh === 12 ? 0 : hh;
  else hh = hh === 12 ? 12 : hh + 12;
  const iso = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, "0")}-${String(
    probe.getDate()
  ).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateISOPHT(dateLabel: string): string {
  const probe = new Date(`${dateLabel} 12:00:00`);
  if (Number.isNaN(probe.getTime())) return "";
  return `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, "0")}-${String(
    probe.getDate()
  ).padStart(2, "0")}`;
}

/** Future weekday label `offset` days out, skipping weekends + excluded labels. */
function futureWeekdayLabel(offset: number, exclude: string[] = []): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (isWeekend(d) || exclude.includes(formatLabel(d))) {
    d.setDate(d.getDate() + 1);
  }
  return formatLabel(d);
}

/** Most recent past weekday label (for read-only history rows). */
function pastWeekdayLabel(offsetBack = 1): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetBack);
  while (isWeekend(d)) d.setDate(d.getDate() - 1);
  return formatLabel(d);
}

async function main() {
  console.log("Seeding STARS database...");

  const studentPass = await bcrypt.hash("student123", 10);
  const adminPass = await bcrypt.hash("Admin@2026!", 10);
  const superAdminPass = await bcrypt.hash("SuperAdmin@2026!", 10);
  const scannerPass = await bcrypt.hash("scan2026", 10);

  const student = await prisma.user.upsert({
    where: { email: "student@pup.edu.ph" },
    update: {},
    create: {
      studentId: "2024-00123-SP-0",
      email: "student@pup.edu.ph",
      passwordHash: studentPass,
      role: "STUDENT",
      name: "Juan dela Cruz",
      course: "BSCS",
      year: "3rd Year",
      approved: true,
    },
  });

  // Super Admin is seeded FIRST so that the legacy admin@pup.edu.ph account
  // (SUPER_ADMIN in older seeds) can be safely narrowed to ADMIN below
  // without ever leaving the database without a Super Admin.
  await prisma.user.upsert({
    where: { email: "superadmin@pup.edu.ph" },
    update: { role: "SUPER_ADMIN", name: "SSO Super Admin", approved: true, active: true },
    create: {
      email: "superadmin@pup.edu.ph",
      passwordHash: superAdminPass,
      role: "SUPER_ADMIN",
      name: "SSO Super Admin",
      approved: true,
    },
  });

  // Normal admin: operational tools only (no super-admin tools — see
  // docs/admin-superadmin-separation-spec.md). The update clause also
  // migrates databases seeded before the Admin/Super Admin split.
  await prisma.user.upsert({
    where: { email: "admin@pup.edu.ph" },
    update: { role: "ADMIN", name: "SSO Admin", approved: true, active: true },
    create: {
      email: "admin@pup.edu.ph",
      passwordHash: adminPass,
      role: "ADMIN",
      name: "SSO Admin",
      approved: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "scanner@pup.edu.ph" },
    update: {},
    create: {
      email: "scanner@pup.edu.ph",
      passwordHash: scannerPass,
      role: "SCANNER",
      name: "Scanner Desk",
      approved: true,
    },
  });

  // Org-rep demo student (Pedro Reyes). Reuses the existing SN account when the
  // DB already has one (e.g. created via registration); otherwise creates the
  // orgrep@pup.edu.ph login. Either way `orgRep` is the account UAT uses for
  // the event filing gate.
  let orgRep = await prisma.user.findUnique({ where: { studentId: "2024-00102-SP-0" } });
  let orgRepLogin = "pedro.reyes@iskolarngbayan.pup.edu.ph (existing account for 2024-00102-SP-0)";
  if (orgRep) {
    orgRep = await prisma.user.update({
      where: { studentId: "2024-00102-SP-0" },
      data: { approved: true, active: true },
    });
  } else {
    orgRep = await prisma.user.upsert({
      where: { email: "orgrep@pup.edu.ph" },
      update: {},
      create: {
        studentId: "2024-00102-SP-0",
        email: "orgrep@pup.edu.ph",
        passwordHash: studentPass,
        role: "STUDENT",
        name: "Pedro Reyes",
        course: "BSIT",
        year: "2nd Year",
        approved: true,
      },
    });
    orgRepLogin = "orgrep@pup.edu.ph / student123  (student number 2024-00102-SP-0)";
  }

  const masterlist: Array<{ sn: string; name: string; email: string; course: string; year: string; schoolYear: string }> = [
    { sn: "2024-00123-SP-0", name: "Juan dela Cruz", email: "student@pup.edu.ph", course: "BSCS", year: "3rd Year", schoolYear: "2026-2027" },
    { sn: "2024-00091-SP-0", name: "Maria Santos", email: "maria.santos@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "2nd Year", schoolYear: "2026-2027" },
    { sn: "2024-00102-SP-0", name: "Pedro Reyes", email: "pedro.reyes@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "2nd Year", schoolYear: "2026-2027" },
    { sn: "2024-00115-SP-0", name: "Ana Flores", email: "ana.flores@iskolarngbayan.pup.edu.ph", course: "BSA", year: "1st Year", schoolYear: "2026-2027" },
    { sn: "2024-00134-SP-0", name: "Liza Manguba", email: "liza.manguba@iskolarngbayan.pup.edu.ph", course: "BEED", year: "4th Year", schoolYear: "2026-2027" },
    { sn: "2024-00145-SP-0", name: "Rico Aguinaldo", email: "rico.aguinaldo@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", schoolYear: "2026-2027" },
    { sn: "2024-00150-SP-0", name: "Jose Mercado", email: "jose.mercado@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "3rd Year", schoolYear: "2026-2027" },
    { sn: "2024-00151-SP-0", name: "Rosa Aquino", email: "rosa.aquino@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "3rd Year", schoolYear: "2026-2027" },
    { sn: "2024-00200-SP-0", name: "Carla Dizon", email: "carla.dizon@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", schoolYear: "2026-2027" },
  ];
  for (const m of masterlist) {
    await prisma.masterlistEntry.upsert({ where: { sn: m.sn }, update: m, create: m });
  }

  // Masterlist groups (super-only groups tab demo).
  const groups = [
    { schoolYear: "2026-2027", course: "BSCS", year: "3rd Year" },
    { schoolYear: "2026-2027", course: "BSIT", year: "2nd Year" },
  ];
  for (const g of groups) {
    await prisma.masterlistGroup.upsert({
      where: { schoolYear_course_year: g },
      update: {},
      create: { ...g, ownerId: null },
    });
  }

  // System settings (mirror DEFAULT_SETTINGS in src/app/api/settings/route.ts
  // so the UI shows seeded — not fallback — state).
  const todayLabel = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date());
  const holidayLabel = futureWeekdayLabel(10);
  const tomorrowLabel = futureWeekdayLabel(1, [holidayLabel]);
  const dayAfterLabel = futureWeekdayLabel(2, [holidayLabel, tomorrowLabel]);
  const pastLabel = pastWeekdayLabel(1);
  const businessHours = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];
  const settings: Array<{ key: string; value: string }> = [
    { key: "businessHours", value: JSON.stringify(businessHours) },
    { key: "appointmentCapacity", value: "1" },
    { key: "cancellationCutoffHours", value: "24" },
    { key: "maxReschedules", value: "2" },
    { key: "holidays", value: JSON.stringify([{ date: holidayLabel, name: "Seed Holiday — SSO closed" }]) },
    { key: "courses", value: JSON.stringify(["BSCS", "BSIT", "BSBA", "BSA", "BEED"]) },
    { key: "emailTemplate", value: "{{message}}\n\n— STARS, PUP San Pedro Student Services Office" },
    { key: "assistant.highScore", value: "6" },
    { key: "assistant.highSimilarity", value: "0.6" },
    { key: "assistant.mediumSimilarity", value: "0.45" },
  ];
  for (const s of settings) {
    await prisma.systemSetting.upsert({ where: { key: s.key }, update: {}, create: s });
  }

  const serviceConfigs: Array<{ service: string; durationMin: number; capacity: number; weekdays: number[] }> = [
    { service: "GENERAL", durationMin: 10, capacity: 1, weekdays: [1, 2, 3, 4, 5] },
    { service: "ID_NEW", durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5] },
    { service: "ID_LOST", durationMin: 15, capacity: 3, weekdays: [1, 2, 3, 4, 5] },
    { service: "EVENT", durationMin: 30, capacity: 2, weekdays: [1, 2, 3, 4, 5] },
    { service: "AUTH", durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5] },
    { service: "EXCUSE", durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5] },
    { service: "PSYCH", durationMin: 45, capacity: 1, weekdays: [1, 2, 3, 4, 5] },
  ];
  for (const c of serviceConfigs) {
    await prisma.serviceSlotConfig.upsert({
      where: { service: c.service },
      update: { durationMin: c.durationMin, capacity: c.capacity, weekdays: c.weekdays, active: true },
      create: { service: c.service, durationMin: c.durationMin, capacity: c.capacity, weekdays: c.weekdays, active: true },
    });
  }

  // Organization + representative (org-rep event gate demo).
  const org = await prisma.organization.upsert({
    where: { name: "Seed Computer Society" },
    update: {},
    create: { name: "Seed Computer Society", adviserName: "Dr. Seed Adviser", schoolYear: "2026-2027", active: true },
  });
  const existingRep = await prisma.organizationRepresentative.findFirst({
    where: { organizationId: org.id, studentId: "2024-00102-SP-0" },
  });
  if (!existingRep) {
    await prisma.organizationRepresentative.create({
      data: { organizationId: org.id, studentId: "2024-00102-SP-0", assignedBy: "SSO Super Admin", active: true, expiresAt: null },
    });
  }

  // ServiceRequests (Workflows B + C). GEN-SEED01 is the bundled pair with APT-007.
  const serviceRequests = [
    {
      id: "GEN-SEED01", sn: "2024-00123-SP-0", name: "Juan dela Cruz", service: "GENERAL_VISIT",
      subject: "General SSO visit", details: "Seed: enrollment verification consult.", copies: 1,
      status: "Pending Review", remarks: "", appointmentCode: "APT-007",
      dateLabel: todayLabel, time: "9:30 AM", slotStartAt: parseSlotStart(todayLabel, "9:30 AM"),
    },
    {
      id: "AUT-SEED01", sn: "2024-00123-SP-0", name: "Juan dela Cruz", service: "AUTHENTICATION",
      subject: "Authentication for scholarship", details: "Seed: authentication request awaiting review.", copies: 1,
      status: "Approved", remarks: "", appointmentCode: null, dateLabel: "", time: "", slotStartAt: null,
    },
    {
      id: "AUT-SEED02", sn: "2024-00091-SP-0", name: "Maria Santos", service: "AUTHENTICATION",
      subject: "Authentication for government transaction", details: "Seed: ready for pickup.", copies: 2,
      status: "Ready for Pickup", remarks: "", appointmentCode: null, dateLabel: "", time: "", slotStartAt: null,
    },
    {
      id: "EXC-SEED01", sn: "2024-00102-SP-0", name: "Pedro Reyes", service: "EXCUSE_SLIP",
      subject: "Excuse slip", details: "Seed: pickup scheduled.", copies: 1,
      status: "Pickup Scheduled", remarks: "", appointmentCode: null, dateLabel: "", time: "", slotStartAt: null,
    },
    {
      id: "EXC-SEED02", sn: "2024-00115-SP-0", name: "Ana Flores", service: "EXCUSE_SLIP",
      subject: "Excuse slip", details: "Seed: needs supporting document.", copies: 1,
      status: "Needs Revision", remarks: "Seed: attach supporting document.", appointmentCode: null, dateLabel: "", time: "", slotStartAt: null,
    },
  ];
  for (const r of serviceRequests) {
    const history = [{ ts: formatLabel(daysAgo(1)), status: "Pending Review", by: r.name }];
    const pickup =
      r.id === "EXC-SEED01"
        ? { pickupDate: tomorrowLabel, pickupTime: "9:00 AM", pickupNote: "Seed pickup" }
        : { pickupDate: "", pickupTime: "", pickupNote: "" };
    await prisma.serviceRequest.upsert({
      where: { id: r.id },
      update: r.id === "GEN-SEED01" ? { appointmentCode: "APT-007" } : {},
      create: {
        id: r.id, sn: r.sn, name: r.name, service: r.service, subject: r.subject,
        details: r.details, copies: r.copies, status: r.status, remarks: r.remarks,
        history, appointmentCode: r.appointmentCode, dateLabel: r.dateLabel, time: r.time,
        slotStartAt: r.slotStartAt, ...pickup, createdAt: daysAgo(1),
      },
    });
  }

  // ID applications (pickup-leg demo; no direct QueueEntry — requestOnly lanes).
  const idApps = [
    { id: "IDA-SEED01", sn: "2024-00123-SP-0", name: "Juan dela Cruz", type: "New", reason: "Seed: first ID.", orName: "OR-Seed-001", orUrl: "/uploads/seed/or-001.png", status: "Pending" },
    { id: "IDA-SEED02", sn: "2024-00091-SP-0", name: "Maria Santos", type: "Lost", reason: "Seed: lost ID.", orName: "OR-Seed-002", orUrl: "/uploads/seed/or-002.png", status: "Approved" },
    { id: "IDA-SEED03", sn: "2024-00102-SP-0", name: "Pedro Reyes", type: "New", reason: "Seed: claimed.", orName: "OR-Seed-003", orUrl: "/uploads/seed/or-003.png", status: "Completed" },
  ];
  for (const a of idApps) {
    await prisma.idApplication.upsert({
      where: { id: a.id },
      update: {},
      create: {
        ...a, affidavitName: a.type === "Lost" ? "Affidavit-Seed-002" : null,
        affidavitUrl: a.type === "Lost" ? "/uploads/seed/affidavit-002.png" : null,
        remarks: "", history: [{ ts: formatLabel(daysAgo(2)), status: "Pending", by: a.name }],
        pickupDate: a.id === "IDA-SEED03" ? pastLabel : "",
        pickupTime: a.id === "IDA-SEED03" ? "9:00 AM" : "",
        pickedUpAt: a.id === "IDA-SEED03" ? daysAgo(1) : null,
        createdAt: daysAgo(2),
      },
    });
  }

  // Referrals (REF-SEED01 optionally linked from APT-009; neutral wording only).
  const referrals = [
    { id: "REF-SEED01", sn: "2024-00145-SP-0", name: "Rico Aguinaldo", category: "Psychological Intervention", details: "Seed: personal concern — details in office record.", status: "Pending", appointmentCode: "APT-009", appointmentDate: tomorrowLabel, appointmentTime: "10:30 AM" },
    { id: "REF-SEED02", sn: "2024-00115-SP-0", name: "Ana Flores", category: "Academic Concern", details: "Seed: study load concern.", status: "Completed", appointmentCode: null as string | null, appointmentDate: "", appointmentTime: "" },
  ];
  for (const r of referrals) {
    await prisma.referral.upsert({
      where: { id: r.id },
      update: r.id === "REF-SEED01" ? { appointmentCode: "APT-009" } : {},
      create: { ...r, remarks: "", history: [{ ts: formatLabel(daysAgo(2)), status: "Pending", by: r.name }], createdAt: daysAgo(2) },
    });
  }

  // Event requests (EVT-SEED01 optionally linked from APT-008).
  const events = [
    {
      id: "EVT-SEED01", sn: "2024-00102-SP-0", name: "Pedro Reyes", title: "Seed Org General Assembly",
      org: "Seed Computer Society", organizationId: org.id, adviser: "Dr. Seed Adviser",
      date: dayAfterLabel, time: "1:00 PM", venue: "Seed Hall", participants: "50",
      desc: "Seed: general assembly.", type: "General Assembly", status: "Pending",
      appointmentCode: "APT-008", appointmentDate: tomorrowLabel, appointmentTime: "10:00 AM",
    },
    {
      id: "EVT-SEED02", sn: "2024-00102-SP-0", name: "Pedro Reyes", title: "Seed Org Workshop",
      org: "Seed Computer Society", organizationId: org.id, adviser: "Dr. Seed Adviser",
      date: dayAfterLabel, time: "2:00 PM", venue: "Seed Room", participants: "30",
      desc: "Seed: skills workshop (walk-in consult).", type: "Workshop", status: "Approved",
      appointmentCode: null as string | null, appointmentDate: "", appointmentTime: "",
    },
  ];
  for (const e of events) {
    await prisma.eventRequest.upsert({
      where: { id: e.id },
      update: e.id === "EVT-SEED01" ? { appointmentCode: "APT-008" } : {},
      create: { ...e, budget: "", history: [{ ts: formatLabel(daysAgo(2)), status: "Pending", by: e.name }], createdAt: daysAgo(2) },
    });
  }

  // QueueEntries. APT-004…009 keep their codes (docs/UAT reference them) and are
  // upgraded to workflow-meaningful rows; APT-010…015 are new demo coverage.
  // No two ACTIVE rows share (studentId, dateLabel) — one-active-per-date rule.
  type QSeed = {
    code: string; studentId: string; name: string; time: string; dateLabel: string;
    serviceType: string; status: string; served: boolean; serviceRefId?: string | null;
    organizationId?: string | null; purpose?: string; copies?: number; notes?: string;
    bookedBy?: string | null; rescheduleCount?: number; cancelReason?: string | null; createdDaysAgo: number;
  };
  const queue: QSeed[] = [
    { code: "APT-004", studentId: "2024-00091-SP-0", name: "Maria Santos", time: "8:00 AM", dateLabel: todayLabel, serviceType: "GENERAL", status: "SERVED", served: true, createdDaysAgo: 2 },
    { code: "APT-005", studentId: "2024-00102-SP-0", name: "Pedro Reyes", time: "8:30 AM", dateLabel: todayLabel, serviceType: "GENERAL", status: "SERVED", served: true, createdDaysAgo: 2 },
    { code: "APT-006", studentId: "2024-00115-SP-0", name: "Ana Flores", time: "9:00 AM", dateLabel: todayLabel, serviceType: "GENERAL", status: "SERVED", served: true, createdDaysAgo: 2 },
    { code: "APT-007", studentId: "2024-00123-SP-0", name: "Juan dela Cruz", time: "9:30 AM", dateLabel: todayLabel, serviceType: "GENERAL", status: "BOOKED", served: false, serviceRefId: "GEN-SEED01", purpose: "Enrollment verification consult", copies: 1, createdDaysAgo: 1 },
    { code: "APT-008", studentId: "2024-00134-SP-0", name: "Liza Manguba", time: "10:00 AM", dateLabel: tomorrowLabel, serviceType: "EVENT", status: "PENDING_APPROVAL", served: false, serviceRefId: "EVT-SEED01", organizationId: org.id, purpose: "Event consultation", createdDaysAgo: 1 },
    { code: "APT-009", studentId: "2024-00145-SP-0", name: "Rico Aguinaldo", time: "10:30 AM", dateLabel: tomorrowLabel, serviceType: "PSYCH", status: "BOOKED", served: false, serviceRefId: "REF-SEED01", notes: "", createdDaysAgo: 1 },
    { code: "APT-010", studentId: "2024-00123-SP-0", name: "Juan dela Cruz", time: "8:00 AM", dateLabel: tomorrowLabel, serviceType: "GENERAL", status: "PENDING_APPROVAL", served: false, purpose: "Follow-up visit", createdDaysAgo: 0 },
    { code: "APT-011", studentId: "2024-00091-SP-0", name: "Maria Santos", time: "1:00 PM", dateLabel: todayLabel, serviceType: "EVENT", status: "CANCELLED", served: false, cancelReason: "Seed: duplicate booking", createdDaysAgo: 1 },
    { code: "APT-012", studentId: "2024-00102-SP-0", name: "Pedro Reyes", time: "1:30 PM", dateLabel: pastLabel, serviceType: "GENERAL", status: "NO_SHOW", served: false, createdDaysAgo: 2 },
    { code: "APT-013", studentId: "2024-00115-SP-0", name: "Ana Flores", time: "2:00 PM", dateLabel: tomorrowLabel, serviceType: "GENERAL", status: "RESCHEDULED", served: false, rescheduleCount: 1, createdDaysAgo: 1 },
    { code: "APT-014", studentId: "2024-00134-SP-0", name: "Liza Manguba", time: "2:30 PM", dateLabel: todayLabel, serviceType: "GENERAL", status: "CHECKED_IN", served: false, createdDaysAgo: 0 },
    { code: "APT-015", studentId: "2024-00145-SP-0", name: "Rico Aguinaldo", time: "8:00 AM", dateLabel: dayAfterLabel, serviceType: "GENERAL", status: "BOOKED", served: false, bookedBy: "SSO Admin", createdDaysAgo: 0 },
  ];
  const legacyCodes = new Set(["APT-004", "APT-005", "APT-006", "APT-007", "APT-008", "APT-009"]);
  for (const q of queue) {
    const slotStart = parseSlotStart(q.dateLabel, q.time);
    const durationMin = q.serviceType === "EVENT" ? 30 : q.serviceType === "PSYCH" ? 45 : 10;
    const slotEnd = slotStart ? new Date(slotStart.getTime() + durationMin * 60000) : null;
    const data = {
      studentId: q.studentId, name: q.name, time: q.time, dateLabel: q.dateLabel,
      served: q.served, serviceType: q.serviceType, serviceRefId: q.serviceRefId ?? null,
      organizationId: q.organizationId ?? null, notes: q.notes ?? "", status: q.status,
      dateISO: dateISOPHT(q.dateLabel), slotStartAt: slotStart, slotEndAt: slotEnd,
      cancelReason: q.cancelReason ?? null, bookedBy: q.bookedBy ?? null,
      rescheduleCount: q.rescheduleCount ?? 0, purpose: q.purpose ?? "", copies: q.copies ?? 1,
    };
    await prisma.queueEntry.upsert({
      where: { code: q.code },
      // Upgrade pre-workflow rows (generic GENERAL/BOOKED defaults) to their
      // spec roles; leave newer demo rows untouched on reseed (F-1).
      update: legacyCodes.has(q.code) ? data : {},
      create: { code: q.code, ...data, createdAt: daysAgo(q.createdDaysAgo) },
    });
  }

  // Slot block on the seeded holiday (availability renders blocked/remaining 0).
  const existingBlock = await prisma.slotBlock.findFirst({ where: { dateLabel: holidayLabel, reason: "Seed: maintenance" } });
  if (!existingBlock) {
    await prisma.slotBlock.create({
      data: { dateLabel: holidayLabel, time: null, service: null, reason: "Seed: maintenance", createdBy: "SSO Super Admin" },
    });
  }

  // Notifications (target "admin" broadcast + SN-scoped).
  const notifCount = await prisma.notification.count();
  if (notifCount === 0) {
    await prisma.notification.createMany({
      data: [
        { target: "admin", title: "New Booking Request", body: "Seed: Liza Manguba requested EVENT on " + tomorrowLabel + " (APT-008)." },
        { target: "2024-00123-SP-0", title: "Appointment Booked", body: "Seed: your visit APT-007 is booked for " + todayLabel + "." },
        { target: "admin", title: "New General Visit Request", body: "Seed: Juan dela Cruz filed GEN-SEED01 — awaiting approval." },
      ],
    });
  }

  const emailCount = await prisma.emailLog.count();
  if (emailCount === 0) {
    await prisma.emailLog.createMany({
      data: [
        { to: "student@pup.edu.ph", name: "Juan dela Cruz", ref: "APT-007", doc: "Appointment", status: "sent", mode: "simulated" },
        { to: "maria.santos@iskolarngbayan.pup.edu.ph", name: "Maria Santos", ref: "AUT-SEED02", doc: "Authentication", status: "sent", mode: "simulated" },
      ],
    });
  }

  const auditCount = await prisma.auditLog.count();
  if (auditCount === 0) {
    await prisma.auditLog.createMany({
      data: [
        { type: "INFO", msg: `System boot. Database seeded.` },
        { type: "INFO", msg: "REQ approved by SSO Admin." },
        { type: "WARN", msg: "Failed login attempt for unknown user." },
        { type: "INFO", msg: "Queue and notifications initialized." },
      ],
    });
  }
  for (const msg of ["Appointment APT-008 booked (EVENT)", "General Visit GEN-SEED01 filed"]) {
    const found = await prisma.auditLog.findFirst({ where: { msg } });
    if (!found) await prisma.auditLog.create({ data: { type: "INFO", msg } });
  }

  // Bulletins (2 published + 1 draft).
  const bulletins = [
    { id: "BUL-SEED01", title: "Seed: SSO Office Hours", category: "Announcement", body: "Seed: Monday to Friday, 8:00 AM – 5:00 PM.", featured: true, status: "Published" },
    { id: "BUL-SEED02", title: "Seed: Org Assembly Reminder", category: "Events", body: "Seed: file event requests at least 10 working days ahead.", featured: false, status: "Published" },
    { id: "BUL-SEED03", title: "Seed: Draft Notice", category: "Announcement", body: "Seed draft.", featured: false, status: "Draft" },
  ];
  for (const b of bulletins) {
    await prisma.bulletin.upsert({
      where: { id: b.id },
      update: {},
      create: { ...b, publishAt: b.status === "Published" ? daysAgo(1) : null, createdAt: daysAgo(1) },
    });
  }

  // Downloadable forms (URL placeholders only — no binary blobs).
  const forms = [
    { id: "FRM-SEED01", title: "Seed: Affidavit of Loss Template", cat: "ID", fileName: "affidavit-of-loss-template.pdf", url: "/uploads/seed/affidavit-of-loss-template.pdf" },
    { id: "FRM-SEED02", title: "Seed: Event Clearance Checklist", cat: "Events", fileName: "event-clearance-checklist.pdf", url: "/uploads/seed/event-clearance-checklist.pdf" },
  ];
  for (const f of forms) {
    await prisma.downloadableForm.upsert({ where: { id: f.id }, update: {}, create: { ...f, createdAt: daysAgo(3) } });
  }

  // Memo (email blast history).
  await prisma.memo.upsert({
    where: { id: "MEM-SEED01" },
    update: {},
    create: {
      id: "MEM-SEED01", subject: "Seed: Welcome to STARS", audienceLabel: "All Students",
      recipients: 9, by: "SSO Super Admin", mode: "SIMULATED", createdAt: daysAgo(3),
    },
  });

  // FAQ categories (deep-link allowlist alignment).
  for (const name of ["Appointments", "Student ID", "Events", "Service Requests", "General"]) {
    await prisma.faqCategory.upsert({ where: { name }, update: {}, create: { name } });
  }

  const faqCount = await prisma.faq.count();
  if (faqCount === 0) {
    await prisma.faq.createMany({
      data: [
        { id: "FAQ-SEED1", cat: "Appointments", q: "How do I book an Authentication or Excuse Slip visit?", a: "Go to Appointments → Book Appointment, choose Authentication or Excuse Slip, enter the purpose and copies, then pick a date and time slot." },
        { id: "FAQ-SEED2", cat: "Appointments", q: "How will I know my appointment is confirmed?", a: "Your booking appears immediately under My Appointments with its code, and the SSO is notified." },
        { id: "FAQ-SEED3", cat: "Student ID", q: "What do I need to bring when claiming my ID?", a: "Bring one valid ID and your QR code/reference number from this portal." },
        { id: "FAQ-SEED4", cat: "Student ID", q: "Is there a payment for a lost ID replacement?", a: "No payment is required for a lost ID replacement. Upload your signed Affidavit of Loss in the ID Application module." },
        { id: "FAQ-SEED5", cat: "Events", q: "How early should our org file an event request?", a: "At least 10 working days before the event date, with your adviser's endorsement attached." },
        { id: "FAQ-SEED7", cat: "Appointments", q: "How do I request an Excuse Slip?", a: "Go to Appointments → Book Appointment, choose Excuse Slip, enter the purpose, then pick a date and time slot. Bring supporting documents to your visit." },
        { id: "FAQ-SEED6", cat: "General", q: "What are the SSO office hours?", a: "Monday to Friday, 8:00 AM – 5:00 PM (no noon break)." },
      ],
    });
  }
  const extraFaqs = [
    { id: "FAQ-SEED8", cat: "Service Requests", q: "How do I track my Authentication or Excuse Slip request?", a: "1. Open Service Requests. 2. Find your request by its code. 3. Follow the steps Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed. You will be notified when it is ready for pickup." },
    { id: "FAQ-SEED9", cat: "Events", q: "Who can file an event request for our organization?", a: "1. An active organization representative files the request. 2. Attach your adviser's endorsement. 3. Track review in Event Requests. Only representatives may file; booking a consultation visit is optional." },
  ];
  for (const f of extraFaqs) {
    await prisma.faq.upsert({ where: { id: f.id }, update: {}, create: f });
  }

  // Chat session + messages (front-door → escalation loop demo).
  await prisma.chatSession.upsert({
    where: { id: "CHAT-SEED01" },
    update: {},
    create: { id: "CHAT-SEED01", userId: student.id, studentId: "2024-00123-SP-0", subject: "Seed: excuse slip help", createdAt: daysAgo(1) },
  });
  const chatMsgCount = await prisma.chatMessage.count({ where: { sessionId: "CHAT-SEED01" } });
  if (chatMsgCount === 0) {
    await prisma.chatMessage.createMany({
      data: [
        { sessionId: "CHAT-SEED01", role: "student", text: "Seed: How do I request an Excuse Slip?" },
        { sessionId: "CHAT-SEED01", role: "assistant", text: "Seed: Go to Appointments → Book Appointment, choose Excuse Slip, enter the purpose, then pick a date and time slot.", faqId: "FAQ-SEED7", confidence: "high" },
        { sessionId: "CHAT-SEED01", role: "student", text: "Seed: I need help with my specific case." },
      ],
    });
  }

  // Tickets (TKT-SEED02 carries the chatbot escalation link).
  const tickets = [
    {
      id: "TKT-SEED01", sn: "2024-00123-SP-0", name: "Juan dela Cruz", category: "General",
      subject: "Seed: help with my visit", status: "Open",
      msgs: [{ from: "student", by: "Juan dela Cruz", text: "Seed: help with my visit.", ts: formatLabel(daysAgo(1)) }],
      chatSessionId: null as string | null,
    },
    {
      id: "TKT-SEED02", sn: "2024-00145-SP-0", name: "Rico Aguinaldo", category: "Appointments",
      subject: "Seed: escalated from chatbot", status: "Open",
      msgs: [{ from: "student", by: "Rico Aguinaldo", text: "Seed: escalated from chatbot.", ts: formatLabel(daysAgo(1)) }],
      chatSessionId: "CHAT-SEED01",
    },
  ];
  for (const t of tickets) {
    await prisma.ticket.upsert({
      where: { id: t.id },
      update: t.id === "TKT-SEED02" ? { chatSessionId: "CHAT-SEED01" } : {},
      create: { ...t, createdAt: daysAgo(1) },
    });
  }

  // Complaint (entry point for student + admin flow).
  await prisma.complaint.upsert({
    where: { id: "CMP-SEED01" },
    update: {},
    create: {
      id: "CMP-SEED01", sn: "2024-00123-SP-0", name: "Juan dela Cruz", category: "Facilities",
      details: "Seed: faucet near SSO office needs repair.", status: "Submitted",
      confidentiality: "Standard", createdAt: daysAgo(2),
    },
  });

  // Profile change (super-only verifications tab demo).
  await prisma.profileChange.upsert({
    where: { id: "SEED-PROFILE-01" },
    update: {},
    create: {
      id: "SEED-PROFILE-01", userId: student.id, studentId: "2024-00123-SP-0",
      name: "Juan dela Cruz", email: "juan.updated@iskolarngbayan.pup.edu.ph",
      course: "BSCS", year: "3rd Year", status: "Pending", createdAt: daysAgo(1),
    },
  });

  // Service feedback + reminder log.
  await prisma.serviceFeedback.upsert({
    where: { requestId: "GEN-SEED01" },
    update: {},
    create: { requestId: "GEN-SEED01", studentId: "2024-00123-SP-0", rating: 5, comment: "Seed feedback" },
  });
  await prisma.reminderLog.upsert({
    where: { reminderKey: "seed:appt:APT-007:24h" },
    update: {},
    create: { reminderKey: "seed:appt:APT-007:24h" },
  });

  console.log("Seed complete. Demo logins:");
  console.log("  Student: student@pup.edu.ph / student123  (or student number 2024-00123-SP-0)");
  console.log("  Org rep student: " + orgRepLogin);
  console.log("  Admin: admin@pup.edu.ph / Admin@2026!");
  console.log("  Super Admin: superadmin@pup.edu.ph / SuperAdmin@2026!");
  console.log("  Scanner: scanner@pup.edu.ph / scan2026");
  console.log(`  (student user id: ${student.id}, org-rep user id: ${orgRep.id})`);
  console.log(`  Dates: today=${todayLabel} tomorrow=${tomorrowLabel} dayAfter=${dayAfterLabel} holiday=${holidayLabel} past=${pastLabel}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
