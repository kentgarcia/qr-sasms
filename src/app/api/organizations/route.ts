import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const orgs = await prisma.organization.findMany({ include: { representatives: { orderBy: { createdAt: "desc" } } }, orderBy: { name: "asc" } });
  const studentIds = [...new Set(orgs.flatMap((org) => org.representatives.map((rep) => rep.studentId)))];
  const students = studentIds.length ? await prisma.user.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, name: true } }) : [];
  const names = new Map(students.map((student) => [student.studentId, student.name]));
  return NextResponse.json(orgs.map((org) => ({ ...org, representatives: org.representatives.map((rep) => ({ ...rep, studentName: names.get(rep.studentId) || "Unknown student" })) })));
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || "").trim(), adviserName = String(body?.adviserName || "").trim(), schoolYear = String(body?.schoolYear || "").trim();
  if (!name || !adviserName) return jsonError(400, "Organization name and faculty adviser are required.", "MISSING_FIELDS");
  const created = await prisma.organization.create({ data: { name, adviserName, schoolYear } }).catch(() => null);
  if (!created) return jsonError(409, "That organization is already registered.", "DUPLICATE_ORGANIZATION");
  await addAudit("INFO", `Organization ${name} registered by ${auth.name}.`);
  return NextResponse.json(created, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "");
  if (!id) return jsonError(400, "Organization is required.", "MISSING_FIELDS");
  const updated = await prisma.organization.update({ where: { id }, data: { active: !!body?.active } }).catch(() => null);
  if (!updated) return jsonError(404, "Organization not found.", "NOT_FOUND");
  await addAudit("WARN", `Organization ${updated.name} ${updated.active ? "activated" : "deactivated"} by ${auth.name}.`);
  return NextResponse.json(updated);
}
