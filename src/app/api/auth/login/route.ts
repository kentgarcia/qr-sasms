import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, setSessionCookie, toClientUser } from "@/lib/auth";
import { addAudit } from "@/lib/notify";
import { jsonError } from "@/lib/http";
import { allowRequest } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const rate = allowRequest(req, "login", 10, 15 * 60 * 1000);
  if (!rate.allowed) return NextResponse.json({ error: "Too many sign-in attempts. Please try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
  const body = await req.json().catch(() => null);
  const identifier = (body?.identifier || "").toString().trim();
  const password = (body?.password || "").toString();

  if (!identifier || !password) {
    return jsonError(400, "Please enter your student number/email and password.", "MISSING_FIELDS");
  }

  const resolved = await prisma.user.findFirst({
    where: {
      OR: [
        { studentId: { equals: identifier, mode: "insensitive" } },
        { email: { equals: identifier, mode: "insensitive" } },
      ],
    },
  });

  if (!resolved) {
    await addAudit("WARN", `Failed login attempt for "${identifier}".`);
    return jsonError(401, "Incorrect credentials. Please try again.", "INVALID_CREDENTIALS");
  }

  const validPassword = await verifyPassword(password, resolved.passwordHash);
  if (!validPassword) {
    await addAudit("WARN", `Failed login attempt for "${identifier}".`);
    return jsonError(401, "Incorrect credentials. Please try again.", "INVALID_CREDENTIALS");
  }

  if (!resolved.active) return jsonError(403, "This account has been deactivated. Please contact the SSO.", "ACCOUNT_DEACTIVATED");

  if (resolved.role === "STUDENT" && !resolved.approved) {
    await addAudit("INFO", `Login blocked — ${resolved.studentId} not yet approved.`);
    return jsonError(403, "Your account is awaiting SSO admin approval.", "NOT_APPROVED");
  }

  let account = resolved;
  if (resolved.role === "STUDENT" && !resolved.verified && resolved.studentId) {
    const { autoVerifyFromMasterlist } = await import("@/lib/verification");
    if (await autoVerifyFromMasterlist(resolved.studentId)) account = { ...resolved, verified: true };
  }

  await setSessionCookie({
    uid: resolved.id,
    studentId: resolved.studentId,
    email: resolved.email,
    name: resolved.name,
    role: resolved.role.toLowerCase() as "student" | "admin" | "super_admin" | "scanner",
    approved: resolved.approved,
  });

  await addAudit("INFO", `${resolved.name} signed in successfully.`);

  return NextResponse.json({ user: toClientUser(account) });
}
