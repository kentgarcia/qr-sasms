import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { isKnownService, validAppointmentDate } from "@/lib/appointments";

/** Admin slot blocks: close a whole day, a time slot, or a service lane. */
export async function GET(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const dateLabel = req.nextUrl.searchParams.get("date");
  const rows = await prisma.slotBlock.findMany({
    where: dateLabel ? { dateLabel } : {},
    orderBy: [{ dateLabel: "asc" }, { time: "asc" }],
    take: 200,
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const dateLabel = (body?.dateLabel || "").toString();
  const time = body?.time != null && String(body.time) !== "" ? String(body.time) : null;
  const service = body?.service != null && String(body.service) !== "" ? String(body.service).toUpperCase() : null;
  const reason = (body?.reason || "").toString().slice(0, 200);
  if (!validAppointmentDate(dateLabel) && Number.isNaN(new Date(`${dateLabel} 12:00:00`).getTime())) {
    return jsonError(400, "Provide a valid closure date.", "INVALID_DATE");
  }
  if (service && !isKnownService(service)) return jsonError(400, "Unknown service.", "SERVICE_NOT_OFFERED");
  const created = await prisma.slotBlock.create({
    data: { dateLabel, time, service, reason, createdBy: auth.name },
  });
  await addAudit("INFO", `Slot blocked by ${auth.name}: ${dateLabel}${time ? ` ${time}` : ""}${service ? ` (${service})` : ""}${reason ? ` — ${reason}` : ""}.`);
  return NextResponse.json(created, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return jsonError(400, "Block id is required.", "MISSING_FIELDS");
  await prisma.slotBlock.deleteMany({ where: { id } });
  await addAudit("INFO", `Slot block ${id} removed by ${auth.name}.`);
  return NextResponse.json({ ok: true });
}
