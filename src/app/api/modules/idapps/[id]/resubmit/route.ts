import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { pushRequestHistory } from "@/lib/service-requests";

/** Student updates an ID application marked Needs Revision (spec §7 revision loop). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.idApplication.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Application not found.", "NOT_FOUND");
  if (existing.sn !== auth.studentId) return jsonError(403, "Access denied.", "FORBIDDEN");
  if (existing.status !== "Needs Revision") {
    return jsonError(409, "Only applications marked Needs Revision may be resubmitted.", "INVALID_STATUS");
  }

  const body = await req.json().catch(() => ({}));
  const reason = (body?.reason ?? existing.reason).toString().trim();
  const orName = (body?.orName ?? existing.orName).toString();
  const orUrl = (body?.orUrl ?? existing.orUrl).toString();
  const affidavitName = body?.affidavitName === undefined ? existing.affidavitName : (body.affidavitName || "").toString() || null;
  const affidavitUrl = body?.affidavitUrl === undefined ? existing.affidavitUrl : (body.affidavitUrl || "").toString() || null;

  if (!reason) return jsonError(400, "Please provide the reason/details.", "MISSING_FIELDS");
  if (existing.type === "ID Replacement — Lost" && !affidavitUrl) {
    return jsonError(400, "An Affidavit of Loss is required for a lost ID replacement.", "AFFIDAVIT_REQUIRED");
  }

  const history = pushRequestHistory(existing.history, {
    status: "Pending",
    by: auth.name,
    note: "Resubmitted after revision",
  });
  const updated = await prisma.idApplication.update({
    where: { id },
    data: { reason, orName, orUrl, affidavitName, affidavitUrl, status: "Pending", history },
  });

  await addAudit("INFO", `ID app ${id} resubmitted by ${auth.name}.`);
  await addNotification("admin", "ID Application Resubmitted", `${auth.name} resubmitted ID application ${id}.`);

  return NextResponse.json(withTs(updated));
}
