import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { validateStrongPassword } from "@/lib/password";
import { addAudit } from "@/lib/notify";
import { jsonError } from "@/lib/http";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = (body?.token || "").toString();
  const password = (body?.password || "").toString();

  if (!token || !password) {
    return jsonError(400, "Reset token and new password are required.", "MISSING_FIELDS");
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return jsonError(400, "This password reset link is invalid or has expired.", "INVALID_RESET_TOKEN");
  }
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const pwdCheck = validateStrongPassword(password);
  if (!pwdCheck.ok) {
    return jsonError(400, pwdCheck.error || "Password is too weak.", "WEAK_PASSWORD");
  }

  const user = await prisma.user.findFirst({
    where: {
      resetToken: tokenHash,
      resetTokenExpiry: { gt: new Date() },
    },
  });

  if (!user) {
    return jsonError(400, "This password reset link is invalid or has expired.", "INVALID_RESET_TOKEN");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      resetToken: null,
      resetTokenExpiry: null,
    },
  });
  await addAudit("INFO", `Password reset completed for ${user.email}`);

  return NextResponse.json({ ok: true, message: "Your password has been reset. You can now sign in." });
}
