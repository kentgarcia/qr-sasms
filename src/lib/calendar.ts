import { APPOINTMENT_SERVICES, parseSlotStart } from "./appointments";

export interface CalendarAppointmentInput {
  code: string;
  service?: string;
  serviceLabel?: string;
  dateLabel: string;
  time: string;
  slotStartAt?: Date | string | null;
  slotEndAt?: Date | string | null;
  durationMin?: number;
  studentName?: string;
  studentId?: string;
  purpose?: string;
  notes?: string;
  location?: string;
}

function toIcsUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcsText(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcsLine(line: string): string {
  const max = 72;
  if (line.length <= max) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, max));
  rest = rest.slice(max);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, max - 1));
    rest = rest.slice(max - 1);
  }
  return parts.join("\r\n");
}

function resolveStartEnd(input: CalendarAppointmentInput): { start: Date; end: Date } {
  let start: Date | null = null;
  if (input.slotStartAt) {
    const parsed = input.slotStartAt instanceof Date ? input.slotStartAt : new Date(input.slotStartAt);
    if (!Number.isNaN(parsed.getTime())) start = parsed;
  }
  if (!start) {
    start = parseSlotStart(input.dateLabel, input.time);
  }
  if (!start) {
    start = new Date();
  }

  let end: Date | null = null;
  if (input.slotEndAt) {
    const parsed = input.slotEndAt instanceof Date ? input.slotEndAt : new Date(input.slotEndAt);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > start.getTime()) {
      end = parsed;
    }
  }
  if (!end) {
    const fallbackDuration =
      input.durationMin ||
      (input.service ? APPOINTMENT_SERVICES[input.service]?.durationMin : undefined) ||
      15;
    end = new Date(start.getTime() + Math.max(10, fallbackDuration) * 60_000);
  }
  return { start, end };
}

/** Build an RFC 5545 .ics calendar invite for a STARS appointment or pickup. */
export function buildAppointmentIcs(input: CalendarAppointmentInput): string {
  const { start, end } = resolveStartEnd(input);
  const now = new Date();
  const label = input.serviceLabel || (input.service ? APPOINTMENT_SERVICES[input.service]?.label : "") || "SSO Appointment";
  const location = input.location || "Student Services Office, PUP San Pedro Campus";
  const summary = `PUP San Pedro SSO — ${label} (${input.code})`;

  const descLines = [
    `Appointment Code: ${input.code}`,
    `Service: ${label}`,
    `Schedule: ${input.dateLabel} at ${input.time} (PHT)`,
  ];
  if (input.studentName || input.studentId) {
    descLines.push(`Student: ${[input.studentName, input.studentId].filter(Boolean).join(" — ")}`);
  }
  if (input.purpose) descLines.push(`Purpose: ${input.purpose}`);
  if (input.notes) descLines.push(`Notes: ${input.notes}`);
  descLines.push("Please present your STARS offline QR pass or appointment code at the SSO Service Desk.");

  const rawLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PUP San Pedro SSO//STARS//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:stars-${input.code.replace(/[^A-Za-z0-9_-]/g, "")}@pup-sanpedro.edu.ph`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `LOCATION:${escapeIcsText(location)}`,
    `DESCRIPTION:${escapeIcsText(descLines.join("\n"))}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(`Reminder: ${summary} starts in 30 minutes.`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return rawLines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** Build a one-tap Google Calendar "Add Event" URL for a STARS appointment. */
export function buildGoogleCalendarUrl(input: CalendarAppointmentInput): string {
  const { start, end } = resolveStartEnd(input);
  const label = input.serviceLabel || (input.service ? APPOINTMENT_SERVICES[input.service]?.label : "") || "SSO Appointment";
  const location = input.location || "Student Services Office, PUP San Pedro Campus";
  const summary = `PUP San Pedro SSO — ${label} (${input.code})`;
  const details = [
    `Appointment Code: ${input.code}`,
    `Service: ${label}`,
    `Schedule: ${input.dateLabel} at ${input.time} (PHT)`,
    input.purpose ? `Purpose: ${input.purpose}` : "",
    "Present your STARS offline QR pass or appointment code at the SSO Service Desk.",
  ]
    .filter(Boolean)
    .join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summary,
    dates: `${toIcsUtc(start)}/${toIcsUtc(end)}`,
    location,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
