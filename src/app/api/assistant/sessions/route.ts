import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

export async function GET() {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const rows = await prisma.chatSession.findMany({
    where: { studentId: auth.studentId || "" },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: { _count: { select: { messages: true } } },
  });
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r._count.messages,
    }))
  );
}
