import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isEmailConfigured, sendMail } from "@/lib/mailer";
import { addAudit } from "@/lib/notify";
import { jsonError } from "@/lib/http";
import crypto from "crypto";
import { allowRequest } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const rate = allowRequest(req, "forgot-password", 5, 15 * 60 * 1000);
  if (!rate.allowed) return NextResponse.json({ error: "Too many reset requests. Please try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
  const body = await req.json().catch(() => null);
  const email = (body?.email || "").toString().trim();

  if (!email) {
    return jsonError(400, "Please enter your email address.", "MISSING_EMAIL");
  }

  
  if (!isEmailConfigured()) {
    return jsonError(
      503,
      "Password reset email is not configured yet. Please contact the SSO administrator.",
      "EMAIL_NOT_CONFIGURED"
    );
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!appUrl) return jsonError(503, "Password reset links are not configured. Please contact the SSO administrator.", "APP_URL_NOT_CONFIGURED");

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });

  
  
  if (!user) {
    return NextResponse.json({ ok: true, message: "If that email exists, a reset link has been sent." });
  }

  
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const resetTokenExpiry = new Date(Date.now() + 3600000); 

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken: resetTokenHash,
      resetTokenExpiry,
    },
  });

  const resetUrl = `${appUrl.replace(/\/$/, "")}/reset-password?token=${resetToken}`;
  const mailResult = await sendMail({
    to: user.email,
    subject: "Password Reset Request - STARS",
    text: `Hello ${user.name},\n\nYou requested a password reset for your STARS account. Click the link below to reset your password:\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.\n\nThis link expires in 1 hour.`,
  });  await prisma.emailLog.create({
    data: {
      to: user.email,
      name: user.name,
      ref: "PWD-" + user.id,
      doc: "Password Reset",
      status: mailResult.ok ? "Success" : "Failed",
      mode: mailResult.mode,
      error: "error" in mailResult ? mailResult.error : null,
    },
  });

  if (!mailResult.ok) {
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: null, resetTokenExpiry: null },
    });
    await addAudit("ERROR", `Password reset email failed for ${user.email}`);
    return jsonError(502, "We couldn't send the reset email. Please try again later.", "EMAIL_SEND_FAILED");
  }

  await addAudit("INFO", `Password reset requested for ${user.email}`);

  return NextResponse.json({ ok: true, message: "If that email exists, a reset link has been sent." });
}
