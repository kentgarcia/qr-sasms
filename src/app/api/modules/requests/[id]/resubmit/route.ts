import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { pushRequestHistory, requestServiceLabel } from "@/lib/service-requests";

/** Student updates a request marked Needs Revision (spec §7 revision loop). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Request not found.", "NOT_FOUND");
  if (existing.sn !== auth.studentId) return jsonError(403, "Access denied.", "FORBIDDEN");
  if (existing.status !== "Needs Revision") {
    return jsonError(409, "Only requests marked Needs Revision may be resubmitted.", "INVALID_STATUS");
  }

  const body = await req.json().catch(() => ({}));
  const g = (k: string, fallback: string) =>
    (body?.[k] ?? fallback).toString().trim().slice(0, 2000);
  const subject = g("subject", g("purpose", existing.subject)).slice(0, 200);
  const details = g("details", g("reason", existing.details));
  const copies = Math.max(1, Math.min(10, parseInt(body?.copies, 10) || existing.copies));
  const docName = (body?.docName ?? existing.docName).toString();
  const docUrl = body?.docUrl === undefined ? existing.docUrl : (body.docUrl || "").toString() || null;

  if (!details) return jsonError(400, "Please provide the reason/details.", "MISSING_FIELDS");

  const history = pushRequestHistory(existing.history, {
    status: "Pending Review",
    by: auth.name,
    note: "Resubmitted after revision",
  });
  const updated = await prisma.serviceRequest.update({
    where: { id },
    data: { subject, details, copies, docName, docUrl, status: "Pending Review", history },
  });

  await addAudit("INFO", `${requestServiceLabel(existing.service)} request ${id} resubmitted by ${auth.name}.`);
  await addNotification("admin", "Request Resubmitted", `${auth.name} resubmitted ${requestServiceLabel(existing.service)} request ${id}.`);

  return NextResponse.json(withTs(updated));
}
