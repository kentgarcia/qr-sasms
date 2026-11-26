import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { validateStrongPassword } from "@/lib/password";
import { addAudit, addNotification } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { jsonError } from "@/lib/http";
import { sendMail, isEmailConfigured, FALLBACK_OTP } from "@/lib/mailer";

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

  
  // Registration is open to everyone with a valid student number format. Listed students are verified
  // right away (and still go through approval); unlisted students get limited access until the SSO verifies them.
  if (!/^\d{4}-\d{4,6}-[A-Za-z]{2}-\d$/.test(normalizedSn)) {
    return jsonError(400, "Student number must look like 2024-00000-SP-0.", "INVALID_SN");
  }
  const masterlistEntry = await prisma.masterlistEntry.findFirst({ where: { sn: normalizedSn }, select: { name: true } });
  const listed = !!masterlistEntry;

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

  // With no SMTP configured the fixed test code is accepted (no email was really sent).
  const usingFallbackOtp = !isEmailConfigured() && otp === FALLBACK_OTP;
  const otpRecord = usingFallbackOtp ? null : await prisma.emailOtp.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      sn: normalizedSn,
      purpose: "REGISTER",
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!usingFallbackOtp) {
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
  }

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
      approved: !listed ? true : false, // listed students wait for approval; unlisted ones sign in with limited access
      verified: listed,
      verifiedAt: listed ? new Date() : null,
      verifiedBy: listed ? "Masterlist match" : null,
    },
  });

  await addAudit("INFO", `New student account created — ${name} (${sn})${listed ? "" : " — not on the masterlist, needs verification"}.`);
  await addNotification("admin", listed ? "Account Approval Needed" : "Account Needs Verification", listed
    ? `${name} (${sn}) registered and is awaiting your approval.`
    : `${name} (${sn}) registered but is not on the masterlist. Please verify the student number.`);
  void (async () => {
    try {
      const mailResult = await sendMail({
        to: email,
        subject: "Account Registration Pending - STARS",
        text: listed
          ? `Hello ${name}, your account has been successfully registered and is currently awaiting approval from the SSO Admin. We will notify you once it's approved.`
          : `Hello ${name}, your account has been created. Your student number is not on our list yet, so the SSO will verify it first. You can sign in now and use the Help Desk; scheduling and requests open once you are verified.`,
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
  return NextResponse.json({ ok: true, id: account.id, verified: listed, approved: account.approved });
}
