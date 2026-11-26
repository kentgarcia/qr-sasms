import { NextResponse } from "next/server";
import { getSession, SessionPayload } from "./auth";
import { prisma } from "./prisma";

export function jsonError(status: number, error: string, code?: string) {
  return NextResponse.json({ error, code: code || null }, { status });
}


export async function requireSession(
  roles?: Array<SessionPayload["role"]>
): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) return jsonError(401, "Not signed in.", "UNAUTHENTICATED");
  
  
  const user = await prisma.user.findUnique({ where: { id: session.uid }, select: { role: true, approved: true, active: true } });
  if (!user || user.role.toLowerCase() !== session.role) return jsonError(401, "Your session is no longer valid. Please sign in again.", "SESSION_REVOKED");
  if (session.role === "student" && !user.approved) return jsonError(403, "Your account is awaiting SSO admin approval.", "NOT_APPROVED");
  if (!user.active) return jsonError(403, "This account has been deactivated. Please contact the SSO.", "ACCOUNT_DEACTIVATED");
  const hasRole = !roles || roles.includes(session.role) || (session.role === "super_admin" && roles.includes("admin"));
  if (!hasRole) {
    return jsonError(403, "Access denied.", "FORBIDDEN");
  }
  return session;
}


/**
 * Like requireSession, but students must also be verified (identity confirmed by the SSO).
 * Staff roles pass through unchanged.
 */
export async function requireVerified(
  roles?: Array<SessionPayload["role"]>
): Promise<SessionPayload | NextResponse> {
  const auth = await requireSession(roles);
  if (auth instanceof NextResponse || auth.role !== "student") return auth;
  let user = await prisma.user.findUnique({ where: { id: auth.uid }, select: { verified: true, studentId: true } });
  if (user && !user.verified && user.studentId) {
    const { autoVerifyFromMasterlist } = await import("./verification");
    if (await autoVerifyFromMasterlist(user.studentId)) user = { ...user, verified: true };
  }
  if (!user?.verified) {
    return jsonError(403, "Your student account is still being verified by the SSO. You can use the Help Desk meanwhile.", "NOT_VERIFIED");
  }
  return auth;
}

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}


/**
 * Strict integer parsing. Accepts a JS integer, or a string of plain digits
 * (optionally signed). Rejects floats, exponents, blanks, NaN, null, arrays, objects.
 * Returns the number, or a ready-to-return 400 NextResponse.
 */
export function parseIntStrict(
  value: unknown,
  opts: { min: number; max: number; field: string; code?: string }
): number | NextResponse {
  const { min, max, field } = opts;
  const code = opts.code || "INVALID_NUMBER";
  let n: number | null = null;
  if (typeof value === "number" && Number.isInteger(value)) n = value;
  else if (typeof value === "string" && /^[+-]?\d{1,9}$/.test(value.trim())) n = parseInt(value.trim(), 10);
  if (n === null || n < min || n > max) {
    return jsonError(400, `${field} must be a whole number from ${min} to ${max}.`, code);
  }
  return n;
}
