import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { normSN } from "@/lib/format";


export async function PATCH(req: NextRequest, { params }: { params: { sn: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const sn = normSN(decodeURIComponent(params.sn));
  const body = await req.json().catch(() => ({}));
  const approve = !!body.approve;

  const user = await prisma.user.findFirst({ where: { studentId: sn } });
  if (!user) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  if (approve) {
    
    
    
    const approval = await prisma.user.updateMany({ where: { id: user.id, approved: false }, data: { approved: true } });
    if (!approval.count) return NextResponse.json({ ok: true, alreadyApproved: true });
    await addAudit("INFO", `Account ${sn} (${user.name}) approved by ${auth.name}.`);
    await notifyStudentByEmail({
      studentId: sn,
      name: user.name,
      title: "Account Approved",
      message: `Welcome, ${user.name}! Your STARS account has been approved by the SSO. You can now sign in and use all student services.`,
      ref: sn,
    });
    await addNotification(sn, "Account Approved", "Your account has been approved — welcome to STARS!");
  } else {
    await notifyStudentByEmail({
      studentId: sn,
      name: user.name,
      title: "Account Not Approved",
      message: "We're sorry — your STARS registration was not approved. Please visit the SSO for assistance.",
      ref: sn,
    });
    await prisma.user.delete({ where: { id: user.id } });
    await addAudit("WARN", `Account ${sn} (${user.name}) rejected by ${auth.name}.`);
  }

  return NextResponse.json({ ok: true });
}
