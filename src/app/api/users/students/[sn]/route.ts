import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { normSN } from "@/lib/format";




export async function PATCH(req: NextRequest, { params }: { params: { sn: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const sn = normSN(decodeURIComponent(params.sn));
  const user = await prisma.user.findFirst({ where: { studentId: sn, role: "STUDENT" } });
  if (!user) return jsonError(404, "Student account not found.", "NOT_FOUND");

  const body = await req.json().catch(() => ({}));
  if (body?.active === undefined) return jsonError(400, "Missing active status.", "MISSING_FIELDS");
  const active = !!body.active;

  const updated = await prisma.user.update({ where: { id: user.id }, data: { active } });
  await addAudit(active ? "INFO" : "WARN", `Student account ${sn} (${user.name}) ${active ? "reactivated" : "put on hold"} by ${auth.email}.`);
  await addNotification(
    sn,
    active ? "Account Reactivated" : "Account On Hold",
    active ? "Your account has been reactivated. You may sign in normally." : "Your account has been placed on hold by the SSO. Please contact the office for assistance."
  );

  return NextResponse.json({ id: updated.id, studentId: updated.studentId, active: updated.active });
}
