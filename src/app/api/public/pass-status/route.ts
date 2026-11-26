import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/http";
import { parseAppointmentQrPayload } from "@/lib/signature";
import { displayStatus, serviceLabel } from "@/lib/appointments";

/**
 * POST /api/public/pass-status  (no login)
 * Body: { payload }                      – a signed STARS1 QR payload, or
 *       { code, studentId }              – manual fallback (both must match).
 * Returns only non-identifying status info: service, date, time, status.
 * No name, student number, notes or purpose is ever returned.
 */
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 15;
}

export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") || "local").split(",")[0].trim();
  if (limited(ip)) return jsonError(429, "Too many attempts. Please wait a minute and try again.", "RATE_LIMITED");

  const body = await req.json().catch(() => ({}));
  const NOT_FOUND = () => jsonError(404, "We couldn't verify that pass. Check the code and try again.", "NOT_FOUND");

  let code = "";
  let studentId = "";
  if (body?.payload) {
    const parsed = parseAppointmentQrPayload(String(body.payload).slice(0, 200));
    if (parsed.kind !== "signed" || !parsed.validSignature) return NOT_FOUND();
    code = parsed.code;
    studentId = parsed.studentId;
  } else {
    code = String(body?.code || "").trim().toUpperCase().slice(0, 30);
    studentId = String(body?.studentId || "").trim().slice(0, 30);
    if (!/^APT-\d{3,}$/.test(code) || !studentId) {
      return jsonError(400, "Enter your appointment code (e.g. APT-123) and student number.", "INVALID_INPUT");
    }
  }

  const entry = await prisma.queueEntry.findUnique({ where: { code } });
  if (!entry || entry.studentId.toUpperCase() !== studentId.toUpperCase()) return NOT_FOUND();

  const discreet = entry.serviceType === "PSYCH";
  return NextResponse.json({
    code: entry.code,
    service: discreet ? "Appointment" : serviceLabel(entry.serviceType),
    dateLabel: entry.dateLabel,
    time: entry.time,
    status: displayStatus(entry.status),
  });
}
