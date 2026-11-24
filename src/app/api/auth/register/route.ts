import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { validateStrongPassword } from "@/lib/password";
import { addAudit, addNotification } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { jsonError } from "@/lib/http";
import { sendMail } from "@/lib/mailer";

const DEFAULT_COURSES = ["BSCS", "BSIT", "BSBA", "BSA", "BEED"];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const first = (body?.first || "").toString().trim();
  const last = (body?.last || "").toString().trim();
  const sn = (body?.sn || "").toString().trim();
  const email = (body?.email || "").toString().trim().toLowerCase();
  const password = (body?.password || "").toString();
  const otp = (body?.otp || "").toString().trim();
  const course = (body?.course || "").toString();
  const year = (body?.year || "").toString();

  if (!first || !last || !sn || !email || !password) {
    return jsonError(400, "Please complete all fields before creating your account.", "MISSING_FIELDS");
  }
  const normalizedSn = normSN(sn);
  const pwdCheck = validateStrongPassword(password, { studentId: normalizedSn, email });
  if (!pwdCheck.ok) {
    return jsonError(400, pwdCheck.error || "Password is too weak.", "WEAK_PASSWORD");
  }
  if (!/^\d{6}$/.test(otp)) {
    return jsonError(400, "Please enter the 6-digit verification code (OTP) sent to your email.", "INVALID_OTP");
  }

  
  
  const courseSetting = await prisma.systemSetting.findUnique({ where: { key: "courses" } });
  let allowedCourses = DEFAULT_COURSES;
  try {
    const savedCourses = courseSetting?.value ? JSON.parse(courseSetting.value) : null;
    if (Array.isArray(savedCourses) && savedCourses.length) allowedCourses = savedCourses;
  } catch {
    
  }
  if (!allowedCourses.includes(course)) {
    return jsonError(400, "Please select an available course.", "INVALID_COURSE");
  }

  
  const masterlistEntry = await prisma.masterlistEntry.findFirst({
    where: { sn: normalizedSn },
  });
  if (!masterlistEntry) {
    await addAudit("WARN", `Registration blocked — ${sn} not in masterlist.`);
    return jsonError(
      404,
      `Student number "${sn}" was not found in the SSO masterlist. Only enrolled students on the official list can register. Double-check your student number or contact the SSO.`,
      "NOT_IN_MASTERLIST"
    );
  }

  const existingBySn = await prisma.user.findFirst({
    where: { studentId: { equals: normalizedSn, mode: "insensitive" } },
  });
  if (existingBySn) {
    return jsonError(409, "An account for this student number already exists. Please sign in instead.", "ALREADY_REGISTERED");
  }

  const existingByEmail = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (existingByEmail) {
    return jsonError(409, "That email is already registered. Please sign in instead.", "EMAIL_TAKEN");
  }

  const otpRecord = await prisma.emailOtp.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      sn: normalizedSn,
      purpose: "REGISTER",
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!otpRecord) {
    return jsonError(400, "Verification code has expired or was not requested. Please request a new OTP.", "INVALID_OTP");
  }
  if (otpRecord.attempts >= 5) {
    return jsonError(429, "Too many incorrect OTP attempts. Please request a new verification code.", "OTP_LOCKED");
  }
  const otpValid = await verifyPassword(otp, otpRecord.codeHash);
  if (!otpValid) {
    await prisma.emailOtp.update({ where: { id: otpRecord.id }, data: { attempts: { increment: 1 } } });
    return jsonError(400, "Incorrect 6-digit verification code. Please check your email and try again.", "INVALID_OTP");
  }
  await prisma.emailOtp.update({ where: { id: otpRecord.id }, data: { usedAt: new Date() } });

  const passwordHash = await hashPassword(password);
  const name = `${first} ${last}`;
  const account = await prisma.user.create({
    data: {
      studentId: normalizedSn,
      email,
      passwordHash,
      role: "STUDENT",
      name,
      course: course || null,
      year: year || null,
      approved: false, // <-- Naka-false ulit para hihingi ng manual approval sa admin
    },
  });

  await addAudit("INFO", `New student account created — ${name} (${sn}).`);
  await addNotification("admin", "Account Approval Needed", `${name} (${sn}) registered and is awaiting your approval.`);
  void (async () => {
    try {
      const mailResult = await sendMail({
        to: email,
        subject: "Account Registration Pending - STARS",
        text: `Hello ${name}, your account has been successfully registered and is currently awaiting approval from the SSO Admin. We will notify you once it's approved.`,
      });
      await prisma.emailLog.create({
        data: {
          to: email, name, ref: "REG-" + account.id, doc: "Account Registration",
          status: mailResult.ok ? "Success" : "Failed", mode: mailResult.mode,
          error: "error" in mailResult ? mailResult.error : null,
        },
      });
    } catch (mailError) {
      console.error("Failed to process registration email:", mailError);
    }
  })();
  return NextResponse.json({ ok: true, id: account.id });
}
