import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";

/**
 * Shared appointment-system domain logic (single source of truth).
 * See docs/appointment-system-spec.md.
 *
 * Service keys: GENERAL (legacy walk-in lane), ID_NEW, ID_LOST, EVENT,
 * AUTH, EXCUSE, PSYCH.
 * Lifecycle statuses: PENDING_APPROVAL (student booking awaiting SSO
 * approval — visible to staff only), BOOKED, RESCHEDULED, CHECKED_IN,
 * SERVED, CANCELLED, NO_SHOW (+ legacy PENDING treated
 * as BOOKED, legacy IN_PROGRESS treated as CHECKED_IN).
 */

export const DEFAULT_HOURS = [
  "8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM",
  "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM",
];

export const ACTIVE_STATUSES = ["BOOKED", "RESCHEDULED", "CHECKED_IN"];
export const TERMINAL_STATUSES = ["SERVED", "CANCELLED", "NO_SHOW"];
/** A pending-approval booking holds its slot until approved or rejected. */
export const PENDING_APPROVAL = "PENDING_APPROVAL";
/** Statuses that occupy slot capacity (confirmed visits + held pending ones). */
export const OCCUPIED_STATUSES = [...ACTIVE_STATUSES, PENDING_APPROVAL];
/** Statuses a student may still reschedule/cancel (pre-visit only, spec §7). */
export const PRE_VISIT_STATUSES = ["BOOKED", "RESCHEDULED", "PENDING"];

export interface ServiceDef {
  label: string;
  linkedType: "IdApplication" | "EventRequest" | "DocumentRequest" | "Referral" | "ServiceRequest" | null;
  /** False = a linked request is optional (walk-in booking allowed). */
  linkRequired: boolean;
  durationMin: number;
  defaultCapacity: number;
  prerequisiteHint: string;
  /**
   * True = request-only lane (spec §2): the student files a request first and
   * never books this lane directly — pickup is scheduled by the SSO when
   * ready. POST /api/queue rejects these with REQUEST_FIRST.
   */
  requestOnly?: boolean;
}

export const APPOINTMENT_SERVICES: Record<string, ServiceDef> = {
  GENERAL: { label: "General SSO Visit", linkedType: "ServiceRequest", linkRequired: false, durationMin: 10, defaultCapacity: 1, prerequisiteHint: "No linked request required." },
  ID_NEW: { label: "ID Application — New", linkedType: "IdApplication", linkRequired: false, durationMin: 10, defaultCapacity: 4, prerequisiteHint: "File an ID application first — pickup is scheduled by the SSO when your ID is ready.", requestOnly: true },
  ID_LOST: { label: "ID Application — Lost", linkedType: "IdApplication", linkRequired: false, durationMin: 15, defaultCapacity: 3, prerequisiteHint: "File a Lost ID application first (OR receipt + Affidavit of Loss) — pickup is scheduled by the SSO when your ID is ready.", requestOnly: true },
  EVENT: { label: "Event Request", linkedType: "EventRequest", linkRequired: false, durationMin: 30, defaultCapacity: 2, prerequisiteHint: "Optionally link one of your event requests." },
  AUTH: { label: "Authentication", linkedType: "ServiceRequest", linkRequired: false, durationMin: 10, defaultCapacity: 4, prerequisiteHint: "File an Authentication request first — pickup is scheduled by the SSO when your documents are ready.", requestOnly: true },
  EXCUSE: { label: "Excuse Slip", linkedType: "ServiceRequest", linkRequired: false, durationMin: 10, defaultCapacity: 4, prerequisiteHint: "File an Excuse Slip request first — pickup is scheduled by the SSO when your slip is ready.", requestOnly: true },
  PSYCH: { label: "Psychological Intervention", linkedType: "Referral", linkRequired: false, durationMin: 45, defaultCapacity: 1, prerequisiteHint: "Optionally link one of your referrals." },
};

export function isKnownService(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(APPOINTMENT_SERVICES, service);
}

export function serviceLabel(service: string): string {
  return APPOINTMENT_SERVICES[service]?.label || service;
}

export function normalizeStatus(status: string | null | undefined): string {
  if (!status) return "BOOKED";
  const s = status.trim().toUpperCase().replace(/[\s-]+/g, "_");
  // Spec-vocabulary aliases (§7): Confirmed → BOOKED, Completed → SERVED.
  if (s === "PENDING") return "BOOKED";
  if (s === "CONFIRMED") return "BOOKED";
  if (s === "COMPLETED") return "SERVED";
  // Retired step (2026-09-29): visits go straight from CHECKED_IN to SERVED.
  if (s === "IN_PROGRESS") return "CHECKED_IN";
  return status;
}

/** Spec-vocabulary display name for an internal appointment status (§7). */
export const APPOINTMENT_DISPLAY_STATUSES: Record<string, string> = {
  PENDING_APPROVAL: "Pending Approval",
  BOOKED: "Confirmed",
  RESCHEDULED: "Rescheduled",
  CHECKED_IN: "Checked In",
  SERVED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No Show",
};

export function displayStatus(status: string | null | undefined): string {
  const s = normalizeStatus(status);
  return APPOINTMENT_DISPLAY_STATUSES[s] || s;
}

/** Return { year, month (1-12), day } for `d` in Asia/Manila. */
export function manilaDateParts(d: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  return {
    year: Number(parts.find((p) => p.type === "year")?.value || 1970),
    month: Number(parts.find((p) => p.type === "month")?.value || 1),
    day: Number(parts.find((p) => p.type === "day")?.value || 1),
  };
}

/** Parse "September 26, 2026" into calendar parts without host-timezone drift. */
function parseDateLabelParts(dateLabel: string): { year: number; month: number; day: number; weekday: number } | null {
  const probe = new Date(`${dateLabel} 12:00:00 UTC`);
  if (Number.isNaN(probe.getTime())) return null;
  const normalized = probe.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (normalized !== dateLabel) return null;
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
    weekday: probe.getUTCDay(),
  };
}

/** Parse "September 26, 2026" + "8:00 AM" into a Date at Asia/Manila (+08:00). */
export function parseSlotStart(dateLabel: string, time: string): Date | null {
  const parts = parseDateLabelParts(dateLabel);
  if (!parts) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(time);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (hh < 1 || hh > 12 || mm > 59) return null;
  if (ap === "AM") hh = hh === 12 ? 0 : hh;
  else hh = hh === 12 ? 12 : hh + 12;
  const iso = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateISOPHT(dateLabel: string): string {
  const parts = parseDateLabelParts(dateLabel);
  if (!parts) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Canonical calendar rule: future weekday within current or next month (Asia/Manila). */
export function validAppointmentDate(label: string): boolean {
  const parts = parseDateLabelParts(label);
  if (!parts) return false;
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  const today = manilaDateParts(new Date());
  const todayNum = today.year * 10000 + today.month * 100 + today.day;
  const targetNum = parts.year * 10000 + parts.month * 100 + parts.day;
  if (targetNum < todayNum) return false;
  // Last day of next month in Manila calendar
  const maxDate = new Date(Date.UTC(today.year, today.month + 1, 0));
  const maxNum = maxDate.getUTCFullYear() * 10000 + (maxDate.getUTCMonth() + 1) * 100 + maxDate.getUTCDate();
  return targetNum <= maxNum;
}

export interface ScheduleSettings {
  hours: string[];
  capacity: number;
  cutoffHours: number;
  maxReschedules: number;
  holidays: Array<{ date: string; name: string }>;
}

export async function getScheduleSettings(): Promise<ScheduleSettings> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ["businessHours", "appointmentCapacity", "cancellationCutoffHours", "maxReschedules", "holidays"] } },
  });
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  let hours: string[] = DEFAULT_HOURS;
  try {
    if (values.businessHours) {
      const parsed = JSON.parse(values.businessHours);
      if (Array.isArray(parsed) && parsed.length) hours = parsed.map(String);
    }
  } catch { /* keep defaults */ }
  let holidays: Array<{ date: string; name: string }> = [];
  try {
    if (values.holidays) {
      const parsed = JSON.parse(values.holidays);
      if (Array.isArray(parsed)) {
        holidays = parsed.map((h: unknown) =>
          typeof h === "string" ? { date: h, name: "" } : { date: String((h as { date?: unknown }).date || ""), name: String((h as { name?: unknown }).name || "") }
        ).filter((h) => h.date);
      }
    }
  } catch { /* keep empty */ }
  return {
    hours,
    capacity: Math.max(1, Number(values.appointmentCapacity || 1)),
    cutoffHours: Math.max(0, Number(values.cancellationCutoffHours ?? 24)),
    maxReschedules: Math.min(10, Math.max(0, Number(values.maxReschedules ?? 2))),
    holidays,
  };
}

export interface ServiceConfig {
  durationMin: number;
  capacity: number;
  weekdays: number[];
  active: boolean;
}

const SEED_CONFIGS: Record<string, ServiceConfig> = {
  GENERAL: { durationMin: 10, capacity: 1, weekdays: [1, 2, 3, 4, 5], active: true },
  ID_NEW: { durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5], active: true },
  ID_LOST: { durationMin: 15, capacity: 3, weekdays: [1, 2, 3, 4, 5], active: true },
  EVENT: { durationMin: 30, capacity: 2, weekdays: [1, 2, 3, 4, 5], active: true },
  AUTH: { durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5], active: true },
  EXCUSE: { durationMin: 10, capacity: 4, weekdays: [1, 2, 3, 4, 5], active: true },
  PSYCH: { durationMin: 45, capacity: 1, weekdays: [1, 2, 3, 4, 5], active: true },
};

/** Per-service config from DB, auto-seeding defaults when the table is empty. */
export async function getServiceConfigs(): Promise<Record<string, ServiceConfig>> {
  let rows = await prisma.serviceSlotConfig.findMany();
  if (rows.length === 0) {
    await prisma.serviceSlotConfig.createMany({
      data: Object.entries(SEED_CONFIGS).map(([service, c]) => ({ service, ...c })),
      skipDuplicates: true,
    });
    rows = await prisma.serviceSlotConfig.findMany();
  }
  const out: Record<string, ServiceConfig> = {};
  for (const [service, seed] of Object.entries(SEED_CONFIGS)) {
    const row = rows.find((r) => r.service === service);
    out[service] = row
      ? { durationMin: row.durationMin, capacity: row.capacity, weekdays: row.weekdays, active: row.active }
      : seed;
  }
  return out;
}

export function slotCapacity(service: string, configs: Record<string, ServiceConfig>, globalCapacity: number): number {
  const c = configs[service];
  if (c && c.active) return Math.max(1, c.capacity);
  return globalCapacity;
}

export function serviceOfferedOn(service: string, dateLabel: string, configs: Record<string, ServiceConfig>): boolean {
  const c = configs[service];
  const parts = parseDateLabelParts(dateLabel);
  if (!parts) return false;
  const day = parts.weekday;
  if (!c || !c.active) return day !== 0 && day !== 6;
  return c.weekdays.includes(day);
}

// ── Prerequisites ─────────────────────────────────────────────

export interface PrereqResult {
  ok: boolean;
  linkedType?: string | null;
  linkedId?: string | null;
  label?: string;
  error?: string;
  code?: string;
}

const ID_LOST_RE = /lost/i;
const PSYCH_RE = /psycholog|counsel|guidance|mental\s*health|intervention/i;
const CLOSED_RE = /^(rejected|cancelled|disapproved|closed|resolved|completed|claimed)$/i;

export async function checkPrerequisite(
  service: string,
  studentId: string,
  linkedId?: string | null
): Promise<PrereqResult> {
  const def = APPOINTMENT_SERVICES[service];
  if (!def) return { ok: false, error: `Unknown service "${service}".`, code: "SERVICE_NOT_OFFERED" };
  if (!def.linkedType) return { ok: true, linkedType: null, linkedId: null };

  if (def.linkedType === "IdApplication") {
    const wantLost = service === "ID_LOST";
    if (linkedId) {
      const rec = await prisma.idApplication.findFirst({ where: { id: linkedId, sn: studentId } });
      if (!rec) return { ok: false, error: "The linked ID application was not found on your account.", code: "PREREQUISITE_MISSING" };
      if (ID_LOST_RE.test(rec.type) !== wantLost) {
        return { ok: false, error: wantLost ? "That application is not a Lost ID application." : "That application is not a New ID application.", code: "PREREQUISITE_MISSING" };
      }
      if (CLOSED_RE.test(rec.status)) return { ok: false, error: `That ID application is ${rec.status} and can no longer be used for booking.`, code: "PREREQUISITE_MISSING" };
      return { ok: true, linkedType: "IdApplication", linkedId: rec.id, label: `${rec.type} (${rec.id})` };
    }
    // Walk-in allowed; ID paperwork lives in the ID Application module.
    return { ok: true, linkedType: "IdApplication", linkedId: null };
  }

  if (def.linkedType === "EventRequest") {
    if (linkedId) {
      const rec = await prisma.eventRequest.findFirst({ where: { id: linkedId, sn: studentId } });
      if (!rec) return { ok: false, error: "The linked event request was not found on your account.", code: "PREREQUISITE_MISSING" };
      if (CLOSED_RE.test(rec.status)) return { ok: false, error: `That event request is ${rec.status} and can no longer be used for booking.`, code: "PREREQUISITE_MISSING" };
      return { ok: true, linkedType: "EventRequest", linkedId: rec.id, label: `"${rec.title}" (${rec.id})` };
    }
    if (!def.linkRequired) return { ok: true, linkedType: "EventRequest", linkedId: null };
    const rep = await prisma.organizationRepresentative.findFirst({
      where: {
        studentId, active: true,
        organization: { active: true },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (!rep) return { ok: false, error: "Only an active organization representative may book an Event Request consultation.", code: "PREREQUISITE_MISSING" };
    const rec = await prisma.eventRequest.findFirst({ where: { sn: studentId }, orderBy: { createdAt: "desc" } });
    if (!rec || CLOSED_RE.test(rec.status)) return { ok: false, error: "File an event request first, then book a consultation appointment.", code: "PREREQUISITE_MISSING" };
    return { ok: true, linkedType: "EventRequest", linkedId: rec.id, label: `"${rec.title}" (${rec.id})` };
  }

  if (def.linkedType === "DocumentRequest") {
    // Legacy lane: document requests were retired and migrated into appointments.
    // Old rows may still carry a serviceRefId for display; new bookings need nothing.
    return { ok: true, linkedType: "DocumentRequest", linkedId: null };
  }

  if (def.linkedType === "ServiceRequest") {
    // Request-based services (spec §§2,5): AUTH → AUTHENTICATION,
    // EXCUSE → EXCUSE_SLIP, GENERAL → GENERAL_VISIT.
    const want =
      service === "AUTH" ? "AUTHENTICATION" : service === "EXCUSE" ? "EXCUSE_SLIP" : "GENERAL_VISIT";
    if (linkedId) {
      const rec = await prisma.serviceRequest.findFirst({ where: { id: linkedId, sn: studentId } });
      if (!rec) return { ok: false, error: "The linked request was not found on your account.", code: "PREREQUISITE_MISSING" };
      if (rec.service !== want) {
        return { ok: false, error: "That request is for a different service.", code: "PREREQUISITE_MISSING" };
      }
      if (CLOSED_RE.test(rec.status)) return { ok: false, error: `That request is ${rec.status} and can no longer be used for booking.`, code: "PREREQUISITE_MISSING" };
      return { ok: true, linkedType: "ServiceRequest", linkedId: rec.id, label: `${rec.subject || rec.service} (${rec.id})` };
    }
    return { ok: true, linkedType: "ServiceRequest", linkedId: null };
  }

  if (def.linkedType === "Referral") {
    if (linkedId) {
      const rec = await prisma.referral.findFirst({ where: { id: linkedId, sn: studentId } });
      if (!rec) return { ok: false, error: "The linked referral was not found on your account.", code: "PREREQUISITE_MISSING" };
      if (CLOSED_RE.test(rec.status)) return { ok: false, error: `That referral is ${rec.status} and can no longer be used for booking.`, code: "PREREQUISITE_MISSING" };
      return { ok: true, linkedType: "Referral", linkedId: rec.id, label: `${rec.category} (${rec.id})` };
    }
    if (!def.linkRequired) return { ok: true, linkedType: "Referral", linkedId: null };
    const recs = await prisma.referral.findMany({ where: { sn: studentId }, orderBy: { createdAt: "desc" } });
    const match = recs.find((r) => !CLOSED_RE.test(r.status)) || recs.find((r) => PSYCH_RE.test(r.category));
    if (!match || CLOSED_RE.test(match.status)) return { ok: false, error: def.prerequisiteHint, code: "PREREQUISITE_MISSING" };
    return { ok: true, linkedType: "Referral", linkedId: match.id, label: `${match.category} (${match.id})` };
  }

  return { ok: false, error: "Unsupported service.", code: "SERVICE_NOT_OFFERED" };
}

/** Bookable linked records for the student + service (for the booking form picker). */
export async function listBookableLinks(service: string, studentId: string) {
  const def = APPOINTMENT_SERVICES[service];
  if (!def?.linkedType) return [];
  if (def.linkedType === "IdApplication") {
    const wantLost = service === "ID_LOST";
    const rows = await prisma.idApplication.findMany({ where: { sn: studentId }, orderBy: { createdAt: "desc" }, take: 20 });
    return rows
      .filter((r) => ID_LOST_RE.test(r.type) === wantLost && !CLOSED_RE.test(r.status))
      .map((r) => ({ id: r.id, label: `${r.type} · ${r.status}` }));
  }
  if (def.linkedType === "EventRequest") {
    const rows = await prisma.eventRequest.findMany({ where: { sn: studentId }, orderBy: { createdAt: "desc" }, take: 20 });
    return rows.filter((r) => !CLOSED_RE.test(r.status)).map((r) => ({ id: r.id, label: `${r.title} · ${r.status}` }));
  }
  if (def.linkedType === "DocumentRequest") return [];
  if (def.linkedType === "ServiceRequest") {
    const want =
      service === "AUTH" ? "AUTHENTICATION" : service === "EXCUSE" ? "EXCUSE_SLIP" : "GENERAL_VISIT";
    const rows = await prisma.serviceRequest.findMany({ where: { sn: studentId, service: want }, orderBy: { createdAt: "desc" }, take: 20 });
    return rows.filter((r) => !CLOSED_RE.test(r.status)).map((r) => ({ id: r.id, label: `${r.subject || r.service} · ${r.status}` }));
  }
  const rows = await prisma.referral.findMany({ where: { sn: studentId }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.filter((r) => !CLOSED_RE.test(r.status)).map((r) => ({ id: r.id, label: `${r.category} · ${r.status}` }));
}

// ── Availability ──────────────────────────────────────────────

export interface SlotInfo {
  time: string;
  capacity: number;
  booked: number;
  remaining: number;
  blocked: boolean;
  blockedReason?: string;
}

export async function getAvailability(dateLabel: string, service?: string) {
  const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
  const svc = service && isKnownService(service) ? service : null;
  const services = svc ? [svc] : Object.keys(APPOINTMENT_SERVICES);
  const [active, blocks] = await Promise.all([
    prisma.queueEntry.findMany({ where: { dateLabel, status: { in: OCCUPIED_STATUSES } }, select: { time: true, serviceType: true } }),
    prisma.slotBlock.findMany({ where: { dateLabel } }),
  ]);
  const counts = new Map<string, number>();
  for (const row of active) counts.set(`${row.serviceType}‖${row.time}`, (counts.get(`${row.serviceType}‖${row.time}`) || 0) + 1);

  const slotsByService: Record<string, SlotInfo[]> = {};
  for (const s of services) {
    const capacity = slotCapacity(s, configs, settings.capacity);
    slotsByService[s] = settings.hours.map((time) => {
      const dayBlock = blocks.find((b) => !b.time && (!b.service || b.service === s));
      const slotBlock = blocks.find((b) => b.time === time && (!b.service || b.service === s));
      const block = slotBlock || dayBlock;
      const booked = counts.get(`${s}‖${time}`) || 0;
      const blocked = !!block;
      return {
        time, capacity, booked,
        remaining: blocked ? 0 : Math.max(0, capacity - booked),
        blocked, blockedReason: block?.reason || undefined,
      };
    });
  }
  const primary = svc || "GENERAL";
  const bookedTimes = slotsByService[primary].filter((s) => s.remaining <= 0).map((s) => s.time);
  return { slots: slotsByService[primary], slotsByService, bookedTimes, capacity: slotCapacity(primary, configs, settings.capacity), settings, configs };
}

/** Serialize an appointment for API responses (backward compatible: keeps q/served). */
export function serializeAppointment(q: {
  code: string; studentId: string; name: string; time: string; dateLabel: string;
  served: boolean; serviceType: string; serviceRefId: string | null; status: string;
  slotStartAt?: Date | null; cancelReason?: string | null; bookedBy?: string | null;
  rescheduleCount?: number | null; purpose?: string | null; copies?: number | null;
  notes?: string | null;
}) {
  const status = normalizeStatus(q.status);
  return {
    q: q.code, studentId: q.studentId, name: q.name, time: q.time, dateLabel: q.dateLabel,
    served: q.served || status === "SERVED",
    service: q.serviceType, serviceLabel: serviceLabel(q.serviceType),
    status, displayStatus: displayStatus(status),
    linkedType: APPOINTMENT_SERVICES[q.serviceType]?.linkedType || null,
    linkedId: q.serviceRefId || undefined,
    startsAt: q.slotStartAt ? q.slotStartAt.toISOString() : undefined,
    cancelReason: q.cancelReason || undefined, bookedBy: q.bookedBy || undefined,
    rescheduleCount: q.rescheduleCount || 0,
    purpose: q.purpose || undefined,
    copies: q.copies && q.copies > 1 ? q.copies : undefined,
    notes: q.notes || undefined,
  };
}

/** Confidentiality masking for the day manifest (spec F-23/F-24). */
export function maskForManifest<T extends { serviceType: string; studentId: string; name: string; serviceRefId: string | null }>(
  q: T, viewerRole: string, viewerStudentId?: string | null
): T {
  if (q.serviceType !== "PSYCH") return q;
  if (viewerRole === "super_admin" || viewerRole === "admin") return q;
  if (viewerStudentId && q.studentId === viewerStudentId) return q;
  return { ...q, name: "Reserved — Confidential", studentId: "••••", serviceRefId: null };
}

/** Run fn with a Postgres advisory lock scoped to a slot (race-safe last-seat booking). */
export async function withSlotLock<T>(lockKey: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    return fn(tx);
  });
}

export interface SlotValidation {
  settings: ScheduleSettings;
  configs: Record<string, ServiceConfig>;
  slotStart: Date;
  slotEnd: Date;
  capacity: number;
}

function slotError(statusCode: number, message: string, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Validate date/time for a service lane. Throws {statusCode, code, message} on failure. */
export async function validateSlotForBooking(
  service: string,
  dateLabel: string,
  time: string
): Promise<SlotValidation> {
  if (!validAppointmentDate(dateLabel)) {
    throw slotError(400, "Please choose a future weekday within the current or next month.", "INVALID_APPOINTMENT_DATE");
  }
  const [settings, configs] = await Promise.all([getScheduleSettings(), getServiceConfigs()]);
  if (!settings.hours.includes(time)) {
    throw slotError(400, "Please choose a valid business-hours time slot.", "INVALID_TIME_SLOT");
  }
  const holiday = settings.holidays.find((h) => h.date === dateLabel);
  if (holiday) {
    throw slotError(400, `The SSO is closed on the selected date${holiday.name ? ` (${holiday.name})` : ""}.`, "HOLIDAY");
  }
  if (!serviceOfferedOn(service, dateLabel, configs)) {
    throw slotError(400, `${serviceLabel(service)} is not offered on the selected day.`, "SERVICE_NOT_OFFERED");
  }
  const slotStart = parseSlotStart(dateLabel, time);
  if (!slotStart) throw slotError(400, "Please choose a valid date and time slot.", "INVALID_APPOINTMENT");
  const capacity = slotCapacity(service, configs, settings.capacity);
  const durationMin = Math.max(5, configs[service]?.durationMin || APPOINTMENT_SERVICES[service].durationMin);
  return { settings, configs, slotStart, slotEnd: new Date(slotStart.getTime() + durationMin * 60000), capacity };
}

export interface LinkedAppointmentInput {
  service: string;
  studentId: string;
  studentName: string;
  dateLabel: string;
  time: string;
  slotStart: Date;
  slotEnd: Date;
  capacity: number;
  linkedId: string | null;
  organizationId?: string | null;
  purpose?: string;
  copies?: number;
  notes?: string;
}

export async function nextAppointmentCode(tx: Prisma.TransactionClient): Promise<string> {
  const base = await tx.queueEntry.count({ where: { status: { not: "CANCELLED" } } });
  let n = base + 1;
  let code = "";
  for (let i = 0; i < 1000; i++) {
    code = `APT-${String(n).padStart(3, "0")}`;
    const clash = await tx.queueEntry.findUnique({ where: { code } });
    if (!clash) break;
    n++;
  }
  return code;
}

/**
 * Mirror appointment code/date/time onto the linked transaction row
 * (ServiceRequest, EventRequest, Referral, IdApplication) inside a transaction.
 */
export async function syncAppointmentFieldsToLinked(
  tx: Prisma.TransactionClient,
  input: {
    service: string;
    linkedId: string | null | undefined;
    code: string;
    dateLabel: string;
    time: string;
    slotStart?: Date | null;
    clear?: boolean;
  }
) {
  if (!input.linkedId) return;
  const svc = (input.service || "").toUpperCase();
  try {
    if (svc === "GENERAL" || svc === "AUTH" || svc === "EXCUSE") {
      const exists = await tx.serviceRequest.findUnique({ where: { id: input.linkedId }, select: { id: true, service: true } });
      if (!exists) return;
      if (exists.service === "GENERAL_VISIT") {
        await tx.serviceRequest.update({
          where: { id: input.linkedId },
          data: input.clear
            ? { appointmentCode: null }
            : {
                appointmentCode: input.code,
                dateLabel: input.dateLabel,
                time: input.time,
                ...(input.slotStart ? { slotStartAt: input.slotStart } : {}),
              },
        });
      } else {
        await tx.serviceRequest.update({
          where: { id: input.linkedId },
          data: input.clear
            ? { appointmentCode: null }
            : { appointmentCode: input.code, pickupDate: input.dateLabel, pickupTime: input.time },
        });
      }
      return;
    }
    if (svc === "EVENT") {
      const exists = await tx.eventRequest.findUnique({ where: { id: input.linkedId }, select: { id: true } });
      if (!exists) return;
      await tx.eventRequest.update({
        where: { id: input.linkedId },
        data: input.clear
          ? { appointmentCode: null, appointmentDate: "", appointmentTime: "" }
          : { appointmentCode: input.code, appointmentDate: input.dateLabel, appointmentTime: input.time },
      });
      return;
    }
    if (svc === "PSYCH") {
      const exists = await tx.referral.findUnique({ where: { id: input.linkedId }, select: { id: true } });
      if (!exists) return;
      await tx.referral.update({
        where: { id: input.linkedId },
        data: input.clear
          ? { appointmentCode: null, appointmentDate: "", appointmentTime: "" }
          : { appointmentCode: input.code, appointmentDate: input.dateLabel, appointmentTime: input.time },
      });
    }
  } catch {
    // Best-effort sync so primary booking transition does not fail on stale links.
  }
}

/**
 * Create or update a confirmed QueueEntry for an admin-scheduled pickup
 * (Authentication, Excuse Slip, ID Application) so pickups appear in the
 * appointment manifest, calendar, and QR scanner.
 */
export async function upsertPickupQueueEntry(
  tx: Prisma.TransactionClient,
  input: {
    service: "AUTH" | "EXCUSE" | "ID_NEW" | "ID_LOST";
    linkedId: string;
    studentId: string;
    studentName: string;
    pickupDate: string;
    pickupTime: string;
    pickupNote?: string;
    bookedBy: string;
  }
) {
  const slotStart = parseSlotStart(input.pickupDate, input.pickupTime);
  const durationMin = APPOINTMENT_SERVICES[input.service]?.durationMin || 10;
  const slotEnd = slotStart ? new Date(slotStart.getTime() + durationMin * 60000) : null;
  const dateISO = dateISOPHT(input.pickupDate);

  const existing = await tx.queueEntry.findFirst({
    where: {
      serviceRefId: input.linkedId,
      serviceType: input.service,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return tx.queueEntry.update({
      where: { id: existing.id },
      data: {
        dateLabel: input.pickupDate,
        time: input.pickupTime,
        dateISO,
        slotStartAt: slotStart,
        slotEndAt: slotEnd,
        status: existing.status === "SERVED" ? "SERVED" : "BOOKED",
        notes: (input.pickupNote || existing.notes || "").slice(0, 500),
        bookedBy: input.bookedBy,
      },
    });
  }

  // Avoid colliding with the partial unique index (studentId, dateLabel) for active rows.
  const sameDayActive = await tx.queueEntry.findFirst({
    where: {
      studentId: input.studentId,
      dateLabel: input.pickupDate,
      status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] },
    },
    select: { code: true },
  });
  if (sameDayActive) {
    // Reuse student's existing same-day appointment code reference if already booked that day.
    return null;
  }

  const code = await nextAppointmentCode(tx);
  return tx.queueEntry.create({
    data: {
      code,
      studentId: input.studentId,
      name: input.studentName,
      time: input.pickupTime,
      dateLabel: input.pickupDate,
      served: false,
      serviceType: input.service,
      serviceRefId: input.linkedId,
      status: "BOOKED",
      dateISO,
      slotStartAt: slotStart,
      slotEndAt: slotEnd,
      bookedBy: input.bookedBy,
      purpose: `${serviceLabel(input.service)} Pickup`,
      notes: (input.pickupNote || "").slice(0, 500),
    },
  });
}

/**
 * Mark any active pickup QueueEntry linked to `linkedId` as SERVED.
 */
export async function completePickupQueueEntry(
  tx: Prisma.TransactionClient,
  linkedId: string
) {
  await tx.queueEntry.updateMany({
    where: {
      serviceRefId: linkedId,
      status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] },
    },
    data: { status: "SERVED", served: true },
  });
}

/**
 * Create an appointment inside an existing slot-locked transaction.
 * Enforces one-active-appointment-per-student-per-date + per-service capacity
 * and generates the next APT-### code. Throws {statusCode, code, message}.
 */
export async function createLinkedAppointment(tx: Prisma.TransactionClient, input: LinkedAppointmentInput) {
  const existingBooking = await tx.queueEntry.findFirst({
    where: { dateLabel: input.dateLabel, studentId: input.studentId, status: { in: [...ACTIVE_STATUSES, "PENDING", PENDING_APPROVAL] } },
  });
  if (existingBooking) {
    throw slotError(409, `You already have appointment ${existingBooking.code} on ${input.dateLabel}.`, "ONE_APPOINTMENT_PER_DATE");
  }
  const taken = await tx.queueEntry.count({
    where: { dateLabel: input.dateLabel, time: input.time, serviceType: input.service, status: { in: OCCUPIED_STATUSES } },
  });
  if (taken >= input.capacity) {
    throw slotError(409, "That time slot was just booked. Please choose another available time.", "TIME_SLOT_TAKEN");
  }
  const code = await nextAppointmentCode(tx);
  return tx.queueEntry.create({
    data: {
      code,
      studentId: input.studentId,
      name: input.studentName,
      time: input.time,
      dateLabel: input.dateLabel,
      served: false,
      serviceType: input.service,
      serviceRefId: input.linkedId,
      organizationId: input.organizationId || null,
      status: "BOOKED",
      dateISO: dateISOPHT(input.dateLabel),
      slotStartAt: input.slotStart,
      slotEndAt: input.slotEnd,
      purpose: (input.purpose || "").slice(0, 200),
      copies: input.copies || 1,
      notes: (input.notes || "").slice(0, 500),
    },
  });
}
