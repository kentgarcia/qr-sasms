import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { hashPassword } from "@/lib/auth";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { sendMail } from "@/lib/mailer";


export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.user.findMany({
    where: { role: "STUDENT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, studentId: true, name: true, email: true, course: true, year: true, active: true, approved: true, createdAt: true },
  });
  // Link each student account to its masterlist record (by student number).
  const sns = [...new Set(rows.map((u) => (u.studentId || "").trim().toUpperCase()).filter(Boolean))];
  const entries = sns.length
    ? await prisma.masterlistEntry.findMany({
        where: { sn: { in: sns } },
        select: { sn: true, name: true, email: true, course: true, year: true, schoolYear: true },
      })
    : [];
  const bySn = new Map(entries.map((e) => [e.sn.trim().toUpperCase(), e]));
  return NextResponse.json(
    rows.map((u) => {
      const key = (u.studentId || "").trim().toUpperCase();
      const masterlist = bySn.get(key) ?? null;
      return { ...u, masterlist, masterlistLinked: !!masterlist };
    })
  );
}

/**
 * Register student account(s) directly from masterlist entries.
 * Super-admin only. Body: { sns: string[] (or single `sn`), password: string }
 * Accounts are created approved + active (no approval queue — the super
 * admin is the authority). Identity (name/email/course/year) is copied from
 * the masterlist entry. Per-row results: created vs skipped with reasons.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const rawSns: unknown[] = Array.isArray(body?.sns)
    ? body.sns
    : body?.sn !== undefined
      ? [body.sn]
      : [];
  const password = String(body?.password || "");
  if (!rawSns.length) {
    return jsonError(400, "Select at least one student to register.", "MISSING_FIELDS");
  }
  if (rawSns.length > 500) {
    return jsonError(400, "Too many accounts at once (maximum 500).", "BATCH_TOO_LARGE");
  }
  if (password.length < 10) {
    return jsonError(400, "Temporary password must be at least 10 characters.", "WEAK_PASSWORD");
  }

  const sns = [...new Set(rawSns.map((s) => normSN(String(s ?? ""))).filter(Boolean))];
  if (!sns.length) {
    return jsonError(400, "Select at least one student to register.", "MISSING_FIELDS");
  }

  const entries = await prisma.masterlistEntry.findMany({ where: { sn: { in: sns } } });
  const bySn = new Map(entries.map((e) => [normSN(e.sn), e]));
  const existingBySn = await prisma.user.findMany({
    where: { studentId: { in: sns } },
    select: { studentId: true },
  });
  const takenSn = new Set(existingBySn.map((u) => normSN(u.studentId ?? "")));
  const entryEmails = entries.map((e) => e.email.trim().toLowerCase()).filter(Boolean);
  const existingByEmail = entryEmails.length
    ? await prisma.user.findMany({
        where: { email: { in: entryEmails, mode: "insensitive" } },
        select: { email: true },
      })
    : [];
  const takenEmail = new Set(existingByEmail.map((u) => u.email.trim().toLowerCase()));

  const passwordHash = await hashPassword(password);
  const created: { sn: string; id: string; name: string; email: string }[] = [];
  const skipped: { sn: string; reason: string }[] = [];

  for (const sn of sns) {
    const entry = bySn.get(sn);
    if (!entry) {
      skipped.push({ sn, reason: "Not in the masterlist." });
      continue;
    }
    if (takenSn.has(sn)) {
      skipped.push({ sn, reason: "Already has a registered account." });
      continue;
    }
    if (takenEmail.has(entry.email.trim().toLowerCase())) {
      skipped.push({ sn, reason: `Email ${entry.email} is already registered.` });
      continue;
    }
    try {
      const user = await prisma.user.create({
        data: {
          studentId: sn,
          email: entry.email,
          passwordHash,
          role: "STUDENT",
          name: entry.name,
          course: entry.course || null,
          year: entry.year || null,
          approved: true,
          active: true,
        },
      });
      takenSn.add(sn);
      takenEmail.add(entry.email.trim().toLowerCase());
      created.push({ sn, id: user.id, name: user.name, email: user.email });
      // Best-effort credentials email — never blocks the response.
      void (async () => {
        try {
          const mailResult = await sendMail({
            to: entry.email,
            subject: "Your STARS Account Is Ready",
            text: `Hello ${entry.name}, your STARS student account has been created by the SSO.\n\nStudent No.: ${sn}\nTemporary password: ${password}\n\nSign in and change your password right away.`,
          });
          await prisma.emailLog.create({
            data: {
              to: entry.email, name: entry.name, ref: "REG-" + user.id, doc: "Account Registration (masterlist)",
              status: mailResult.ok ? "Success" : "Failed", mode: mailResult.mode,
              error: "error" in mailResult ? mailResult.error : null,
            },
          });
        } catch (mailError) {
          console.error("Failed to send masterlist registration email:", mailError);
        }
      })();
    } catch {
      skipped.push({ sn, reason: "Could not create the account." });
    }
  }

  await addAudit(
    "INFO",
    `Student account${sns.length === 1 ? "" : "s"} registered from masterlist by ${auth.email} — ${created.length} created, ${skipped.length} skipped.`
  );
  return NextResponse.json(
    { created, skipped, createdCount: created.length, skippedCount: skipped.length },
    { status: 201 }
  );
}
