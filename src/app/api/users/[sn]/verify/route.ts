import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { normSN } from "@/lib/format";

/**
 * PATCH /api/users/:sn/verify  { verify: boolean }
 * Super Admin confirms (or turns down) an account whose student number was not on the masterlist.
 * Confirming also adds the student to the masterlist so the roster stays complete.
 */
export async function PATCH(req: NextRequest, { params }: { params: { sn: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const sn = normSN(decodeURIComponent(params.sn));
  const body = await req.json().catch(() => ({}));
  const verify = !!body.verify;

  const user = await prisma.user.findFirst({ where: { studentId: sn, role: "STUDENT" } });
  if (!user) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  if (user.verified && verify) return NextResponse.json({ ok: true, alreadyVerified: true });

  if (verify) {
    await prisma.user.update({ where: { id: user.id }, data: { verified: true, verifiedAt: new Date(), verifiedBy: auth.name } });
    await prisma.masterlistEntry.upsert({
      where: { sn },
      update: {},
      create: { sn, name: user.name, email: user.email, course: user.course || "", year: user.year || "" },
    });
    await addAudit("INFO", `Account ${sn} (${user.name}) verified by ${auth.name}.`);
    await addNotification(sn, "Account Verified", "Your student number was confirmed. You can now schedule visits and file requests.");
    await notifyStudentByEmail({
      studentId: sn, name: user.name, title: "Account Verified",
      message: `Hello ${user.name}, the SSO confirmed your student number. You can now schedule visits and file requests in STARS.`, ref: sn,
    });
  } else {
    await notifyStudentByEmail({
      studentId: sn, name: user.name, title: "Account Not Verified",
      message: "We could not confirm your student number. Please visit the SSO with your school ID so we can help.", ref: sn,
    });
    await prisma.user.delete({ where: { id: user.id } });
    await addAudit("WARN", `Account ${sn} (${user.name}) removed — student number could not be verified (by ${auth.name}).`);
  }
  return NextResponse.json({ ok: true });
}
