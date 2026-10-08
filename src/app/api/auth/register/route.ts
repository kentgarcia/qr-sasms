import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
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
  const email = (body?.email || "").toString().trim();
  const password = (body?.password || "").toString();
  const course = (body?.course || "").toString();
  const year = (body?.year || "").toString();

  if (!first || !last || !sn || !email || !password) {
    return jsonError(400, "Please complete all fields before creating your account.", "MISSING_FIELDS");
  }
  if (password.length < 6) {
    return jsonError(400, "Password must be at least 6 characters.", "WEAK_PASSWORD");
  }

  const normalizedSn = normSN(sn);

  
  
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
