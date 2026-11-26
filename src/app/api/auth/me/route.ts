import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clearSessionCookie, getSession, toClientUser } from "@/lib/auth";





export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  const user = await prisma.user.findUnique({ where: { id: session.uid } });
  if (!user || !user.active || user.role.toLowerCase() !== session.role || (user.role === "STUDENT" && !user.approved)) {
    clearSessionCookie();
    return NextResponse.json({ user: null });
  }

  let current = user;
  if (user.role === "STUDENT" && !user.verified && user.studentId) {
    const { autoVerifyFromMasterlist } = await import("@/lib/verification");
    if (await autoVerifyFromMasterlist(user.studentId)) current = { ...user, verified: true };
  }
  return NextResponse.json({ user: toClientUser(current) });
}
