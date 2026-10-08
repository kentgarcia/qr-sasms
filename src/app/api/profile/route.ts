import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  if (auth.role === "super_admin") {
    return NextResponse.json(await prisma.profileChange.findMany({ where: { status: "Pending" }, orderBy: { createdAt: "asc" } }));
  }
  const user = await prisma.user.findUnique({ where: { id: auth.uid }, select: { name: true, email: true, course: true, year: true } });
  const pending = await prisma.profileChange.findFirst({ where: { userId: auth.uid, status: "Pending" }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ user, pending });
}



export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const course = String(body?.course || "").trim() || null;
  const year = String(body?.year || "").trim() || null;
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return jsonError(400, "Enter a name and valid email.", "INVALID_PROFILE");
  await prisma.profileChange.deleteMany({ where: { userId: auth.uid, status: "Pending" } });
  const change = await prisma.profileChange.create({ data: { userId: auth.uid, studentId: auth.studentId || "", name, email, course, year } });
  await addNotification("admin", "Profile Update Awaiting Verification", `${auth.name} submitted a profile update for review.`);
  await addAudit("INFO", `Profile update submitted by ${auth.name}.`);
  return NextResponse.json(change, { status: 201 });
}
