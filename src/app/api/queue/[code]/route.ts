import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { addAudit } from "@/lib/notify";


export async function PATCH(req: NextRequest, { params }: { params: { code: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const code = decodeURIComponent(params.code);
  const entry = await prisma.queueEntry.findUnique({ where: { code } });
  if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const updated = await prisma.queueEntry.update({ where: { code }, data: { served: true, status: "SERVED" } });
  await addAudit("INFO", `${code} — ${entry.name} served by ${auth.name}.`);

  return NextResponse.json({
    q: updated.code,
    studentId: updated.studentId,
    name: updated.name,
    time: updated.time,
    served: updated.served,
  });
}
