import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { withTs } from "@/lib/format";
import { CONFIDENTIALITY_LEVELS, canViewComplaint } from "@/lib/complaints-access";


export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const existing = await prisma.complaint.findUnique({ where: { id } });
  if (!existing || !canViewComplaint(auth, existing)) return jsonError(404, "Complaint not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  const status = (body?.status || existing.status).toString();
  const note = (body?.note || "").toString().trim();
  const confidentiality = (CONFIDENTIALITY_LEVELS as readonly string[]).includes(body?.confidentiality) ? body.confidentiality : existing.confidentiality;
  const assignedTo = body?.assignedTo === undefined ? existing.assignedTo : String(body.assignedTo || "").trim() || null;
  const staffNotes = body?.staffNotes === undefined ? existing.staffNotes : String(body.staffNotes || "").trim();

  const updated = await prisma.complaint.update({ where: { id }, data: { status, note, confidentiality, assignedTo, staffNotes } });

  if (confidentiality !== existing.confidentiality) await addAudit("WARN", `Complaint ${id} confidentiality changed ${existing.confidentiality} -> ${confidentiality} by ${auth.name}.`);
  await addAudit("INFO", `Complaint ${id} set to ${status} by ${auth.name}.`);
  await notifyStudentByEmail({
    studentId: existing.sn,
    name: existing.name,
    title: `Complaint ${id} — ${status}`,
    message: `Your complaint (${existing.category}, ref ${id}) is now: ${status}.${note ? `\n\nResolution note: ${note}` : ""}`,
    ref: id,
  });
  await addNotification(existing.sn, `Complaint ${status}`, `Complaint ${id} is now: ${status}.`);

  return NextResponse.json(withTs(updated));
}
