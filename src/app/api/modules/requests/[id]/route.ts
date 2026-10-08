import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";
import {
  SERVICE_REQUEST_SERVICES,
  allowedRequestTransitions,
  canTransitionRequest,
  requestServiceLabel,
  pushRequestHistory,
} from "@/lib/service-requests";

const PICKUP_STATUSES = ["Ready for Pickup", "Pickup Scheduled"];

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const id = decodeURIComponent(params.id);
  const row = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!row) return jsonError(404, "Request not found.", "NOT_FOUND");
  if (auth.role !== "admin" && auth.role !== "super_admin" && row.sn !== auth.studentId) {
    return jsonError(403, "Access denied.", "FORBIDDEN");
  }
  return NextResponse.json(withTs(row));
}

/**
 * Admin review transitions (minimal flow):
 * Approve / Request Revision / Reject, Ready for Pickup, Pickup Scheduled,
 * Completed, Cancelled.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Request not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status ?? existing.status).toString();
  const remarks = (body?.remarks ?? "").toString().trim().slice(0, 1000);
  const def = SERVICE_REQUEST_SERVICES[existing.service];

  if (status !== existing.status) {
    if (!canTransitionRequest(existing.status, status)) {
      return jsonError(
        409,
        `Cannot move this request from ${existing.status} to ${status}. Allowed: ${allowedRequestTransitions(existing.status).join(", ") || "none"}.`,
        "INVALID_TRANSITION"
      );
    }
    if (PICKUP_STATUSES.includes(status) && def && !def.pickup) {
      return jsonError(400, `${status} applies only to Authentication and Excuse Slip requests.`, "INVALID_TRANSITION");
    }
  }

  const history = pushRequestHistory(existing.history, { status, by: auth.name, note: remarks });
  const updated = await prisma.serviceRequest.update({ where: { id }, data: { status, remarks, history } });

  await addAudit("INFO", `${requestServiceLabel(existing.service)} request ${id} set to ${status} by ${auth.name}.`);

  const label = requestServiceLabel(existing.service);
  let title = `${label} — ${status}`;
  let message = `Your ${label} request (${id}) is now: ${status}.`;
  if (status === "Needs Revision") {
    message += " Please update your request and resubmit for review.";
  } else if (status === "Ready for Pickup") {
    message += " The SSO will schedule your pickup and notify you.";
  } else if (status === "Pickup Scheduled") {
    const when = [updated.pickupDate, updated.pickupTime].filter(Boolean).join(" ");
    message += when ? ` Pickup schedule: ${when}.` : "";
  }
  if (remarks) message += `\n\nRemarks: ${remarks}`;

  await notifyStudentByEmail({ studentId: existing.sn, name: existing.name, title, message, ref: id });
  await addNotification(existing.sn, `${label} ${status}`, `Your ${label} request (${id}) is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
