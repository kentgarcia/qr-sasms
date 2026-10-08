import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { fnow, withTs } from "@/lib/format";
import type { Prisma } from "@prisma/client";
import { REFERRAL_STATUSES } from "@/lib/service-requests";

const TERMINAL = ["Completed", "Rejected", "Cancelled", "No Show"];

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.referral.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Referral not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status ?? existing.status).toString();
  const remarks = (body?.remarks ?? "").toString().trim();

  if (!REFERRAL_STATUSES.includes(status)) {
    return jsonError(400, `Unknown status "${status}". Allowed: ${REFERRAL_STATUSES.join(", ")}.`, "INVALID_STATUS");
  }
  if (TERMINAL.includes(existing.status) && status !== existing.status) {
    return jsonError(409, `This referral is already ${existing.status}.`, "INVALID_TRANSITION");
  }

  const history = Array.isArray(existing.history) ? (existing.history as Prisma.JsonArray) : [];
  history.push({ ts: fnow(), status, by: auth.name });

  const updated = await prisma.referral.update({
    where: { id },
    data: { status, remarks, history },
  });

  await addAudit("INFO", `Referral ${id} set to ${status} by ${auth.name}.`);
  let message = `Your referral/intervention request (${existing.category}) is now: ${status}.`;
  if (status === "Needs Revision") message += " Please update your request and resubmit it for review.";
  if (remarks) message += `\n\nRemarks: ${remarks}`;
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: `Referral — ${status}`,
    message,
    ref: id,
  });
  await addNotification(existing.sn, `Referral ${status}`, `Your ${existing.category} referral is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
