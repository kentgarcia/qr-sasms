import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { fnow, withTs } from "@/lib/format";
import type { Prisma } from "@prisma/client";

/** Student updates a referral marked Needs Revision (spec §7 revision loop). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.referral.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Referral not found.", "NOT_FOUND");
  if (existing.sn !== auth.studentId) return jsonError(403, "Access denied.", "FORBIDDEN");
  if (existing.status !== "Needs Revision") {
    return jsonError(409, "Only referrals marked Needs Revision may be resubmitted.", "INVALID_STATUS");
  }

  const body = await req.json().catch(() => ({}));
  const category = (body?.category ?? existing.category).toString();
  const details = (body?.details ?? existing.details).toString().trim();
  if (!details) return jsonError(400, "Please describe your concern.", "MISSING_FIELDS");

  const history = Array.isArray(existing.history) ? (existing.history as Prisma.JsonArray) : [];
  history.push({ ts: fnow(), status: "Pending", by: auth.name, note: "Resubmitted after revision" });

  const updated = await prisma.referral.update({
    where: { id },
    data: { category, details, status: "Pending", history },
  });

  await addAudit("INFO", `Referral ${id} resubmitted by ${auth.name}.`);
  await addNotification("admin", "Referral Resubmitted", `${auth.name} resubmitted referral ${id}.`);

  return NextResponse.json(withTs(updated));
}
