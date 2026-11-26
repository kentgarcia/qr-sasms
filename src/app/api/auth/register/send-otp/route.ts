import { randomInt } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { normSN } from "@/lib/format";
import { jsonError } from "@/lib/http";
import { sendMail } from "@/lib/mailer";
import { allowRequest } from "@/lib/rate-limit";
import { addAudit } from "@/lib/notify";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/**
 * POST /api/auth/register/send-otp
 * Generates and emails a 6-digit OTP to verify Gmail / PUP email ownership
 * before student account creation (spec S-4 / F-4.2).
 */
export async function POST(req: NextRequest) {
  const rl = allowRequest(req, "register-otp", 8, 60 * 60 * 1000);
  if (!rl.allowed) {
    return jsonError(429, "Too many OTP requests. Please try again later.", "RATE_LIMITED");
  }

  const body = await req.json().catch(() => null);
  const sn = normSN(body?.sn || "");
  const email = String(body?.email || "").trim().toLowerCase();

  if (!sn || !email) {
    return jsonError(400, "Please enter your student number and email address first.", "MISSING_FIELDS");
  }
  if (!EMAIL_RE.test(email)) {
    return jsonError(400, "Please enter a valid email address (e.g. Gmail or PUP email).", "INVALID_EMAIL");
  }

  // Students who are not on the masterlist yet may still register; the SSO verifies them afterwards.
  const masterlistEntry = await prisma.masterlistEntry.findFirst({ where: { sn }, select: { name: true } });

  const existingBySn = await prisma.user.findFirst({
    where: { studentId: { equals: sn, mode: "insensitive" } },
    select: { id: true },
  });
  if (existingBySn) {
    return jsonError(409, "An account for this student number already exists. Please sign in instead.", "ALREADY_REGISTERED");
  }

  const existingByEmail = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existingByEmail) {
    return jsonError(409, "That email is already registered. Please sign in instead.", "EMAIL_TAKEN");
  }

  const recent = await prisma.emailOtp.findFirst({
    where: { email, purpose: "REGISTER", usedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - recent.createdAt.getTime())) / 1000);
    return jsonError(429, `Please wait ${waitSec}s before requesting another verification code.`, "OTP_COOLDOWN");
  }

  const code = String(randomInt(100000, 1000000));
  const codeHash = await hashPassword(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.emailOtp.create({
    data: { email, sn, purpose: "REGISTER", codeHash, expiresAt },
  });

  const mailResult = await sendMail({
    to: email,
    subject: "STARS Verification Code (OTP)",
    text: `Your STARS registration verification code is: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.\n\n— PUP San Pedro Student Services Office`,
  });

  await prisma.emailLog.create({
    data: {
      to: email,
      name: masterlistEntry?.name || sn,
      ref: `OTP-${sn}`,
      doc: "Registration OTP",
      status: mailResult.ok ? "Success" : "Failed",
      mode: mailResult.mode,
      error: "error" in mailResult ? mailResult.error : null,
    },
  });
  await addAudit("INFO", `Registration OTP issued for ${sn} (${email}) via ${mailResult.mode}.`);

  return NextResponse.json({
    ok: true,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    mode: mailResult.mode,
  });
}
