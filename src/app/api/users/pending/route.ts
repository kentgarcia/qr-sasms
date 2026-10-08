import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const pending = await prisma.user.findMany({
    where: { role: "STUDENT", approved: false },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    pending.map((u) => ({
      id: u.studentId,
      name: u.name,
      email: u.email,
      course: u.course || "",
      year: u.year || "",
    }))
  );
}
