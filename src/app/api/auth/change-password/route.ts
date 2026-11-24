import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { validateStrongPassword } from "@/lib/password";
import { addAudit } from "@/lib/notify";


export async function POST(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const currentPassword = (body?.currentPassword || "").toString();
  const newPassword = (body?.newPassword || "").toString();
  if (!currentPassword || !newPassword) return jsonError(400, "Enter your current and new password.", "MISSING_FIELDS");
  const pwdCheck = validateStrongPassword(newPassword, { studentId: auth.studentId, email: auth.email });
  if (!pwdCheck.ok) return jsonError(400, pwdCheck.error || "New password is too weak.", "WEAK_PASSWORD");

  const user = await prisma.user.findUnique({ where: { id: auth.uid } });
  if (!user) return jsonError(404, "Account not found.", "NOT_FOUND");

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) return jsonError(401, "Current password is incorrect.", "INVALID_PASSWORD");

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  await addAudit("INFO", `${user.name} changed their password.`);

  return NextResponse.json({ ok: true });
}
