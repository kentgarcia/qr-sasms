import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { PENDING_APPROVAL, PRE_VISIT_STATUSES, getScheduleSettings, normalizeStatus, parseSlotStart, serviceLabel } from "@/lib/appointments";

async function cancelOwn(code: string, studentId: string, name: string, reason?: string) {
  const entry = await prisma.queueEntry.findFirst({ where: { code, studentId } });
  if (!entry) return jsonError(404, "Appointment not found.", "NOT_FOUND");
  if (!PRE_VISIT_STATUSES.includes(normalizeStatus(entry.status)) && normalizeStatus(entry.status) !== PENDING_APPROVAL) {
    return jsonError(409, "Only upcoming appointments can be cancelled.", "INVALID_STATE");
  }
  const settings = await getScheduleSettings();
  const start = parseSlotStart(entry.dateLabel, entry.time);
  if (start && start.getTime() - Date.now() < settings.cutoffHours * 3600000) {
    return jsonError(409, `Appointments can only be cancelled at least ${settings.cutoffHours} hours before the scheduled time.`, "CUTOFF_PASSED");
  }
  await prisma.queueEntry.update({ where: { code }, data: { status: "CANCELLED", cancelReason: reason || null } });
  const discreet = entry.serviceType === "PSYCH";
  await addAudit("INFO", discreet ? `${code} cancelled by ${name}.` : `${code} (${serviceLabel(entry.serviceType)}) cancelled by ${name}.`);
  await addNotification("admin", "Appointment Cancelled", `${name} cancelled ${code}.`);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const code = decodeURIComponent(params.code);
  return cancelOwn(code, auth.studentId || "", auth.name);
}

export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const code = decodeURIComponent(params.code);
  return cancelOwn(code, auth.studentId || "", auth.name, (body?.reason || "").toString() || undefined);
}
