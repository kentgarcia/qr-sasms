import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification, notifyStudentByEmail } from "@/lib/notify";
import { normSN } from "@/lib/format";

/**
 * POST /api/users/batch-approve
 * Super Admin batch approval or rejection of pending student registrations.
 * Body: { studentIds: string[], approve: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const rawIds = Array.isArray(body?.studentIds) ? body.studentIds : [];
  const approve = Boolean(body?.approve);

  const studentIds: string[] = Array.from(
    new Set<string>(rawIds.map((x: unknown) => normSN(String(x || ""))).filter(Boolean))
  ).slice(0, 100);
  if (!studentIds.length) {
    return jsonError(400, "Select at least one pending student account.", "MISSING_FIELDS");
  }

  const users = await prisma.user.findMany({
    where: { studentId: { in: studentIds }, role: "STUDENT", approved: false },
  });

  let processed = 0;
  let skipped = studentIds.length - users.length;

  for (const user of users) {
    const sn = user.studentId || "";
    if (!sn) {
      skipped++;
      continue;
    }
    if (approve) {
      const updated = await prisma.user.updateMany({
        where: { id: user.id, approved: false },
        data: { approved: true },
      });
      if (!updated.count) {
        skipped++;
        continue;
      }
      await notifyStudentByEmail({
        studentId: sn,
        name: user.name,
        title: "Account Approved",
        message: `Welcome, ${user.name}! Your STARS account has been approved by the SSO. You can now sign in and use all student services.`,
        ref: sn,
      });
      await addNotification(sn, "Account Approved", "Your account has been approved — welcome to STARS!");
      processed++;
    } else {
      await notifyStudentByEmail({
        studentId: sn,
        name: user.name,
        title: "Account Not Approved",
        message: "We're sorry — your STARS registration was not approved. Please visit the SSO for assistance.",
        ref: sn,
      });
      await prisma.user.delete({ where: { id: user.id } });
      processed++;
    }
  }

  await addAudit(
    approve ? "INFO" : "WARN",
    `Batch account ${approve ? "approval" : "rejection"} by ${auth.name}: ${processed} processed, ${skipped} skipped.`
  );

  return NextResponse.json({ ok: true, processed, skipped });
}
