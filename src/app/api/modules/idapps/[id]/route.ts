import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { pushRequestHistory, ID_STATUSES } from "@/lib/service-requests";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.idApplication.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Application not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status ?? existing.status).toString();
  const remarks = (body?.remarks ?? "").toString().trim();

  if (!ID_STATUSES.includes(status)) {
    return jsonError(400, `Unknown status "${status}". Allowed: ${ID_STATUSES.join(", ")}.`, "INVALID_STATUS");
  }
  if (["Claimed", "Completed", "Rejected", "Cancelled"].includes(existing.status) && status !== existing.status) {
    return jsonError(409, `This application is already ${existing.status}.`, "INVALID_TRANSITION");
  }

  const history = pushRequestHistory(existing.history, { status, by: auth.name, note: remarks });
  const updated = await prisma.idApplication.update({ where: { id }, data: { status, remarks, history } });

  await addAudit("INFO", `ID app ${id} set to ${status} by ${auth.name}.`);

  let msg = `Your ${existing.type} application is now: ${status}.`;
  if (status === "Needs Revision") msg += "\n\nPlease update your application and resubmit it for review.";
  if (status === "Ready for Claiming") msg += "\n\nYour ID is ready! Please claim it at the SSO. Bring one valid ID.";
  if (remarks) msg += `\n\nRemarks: ${remarks}`;

  await notifyStudentByEmail({ studentId: existing.sn, name: existing.name, title: `Student ID — ${status}`, message: msg, ref: id });
  await addNotification(existing.sn, `ID Application ${status}`, `Your ${existing.type} is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
