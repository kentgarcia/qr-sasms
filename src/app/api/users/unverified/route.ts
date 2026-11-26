import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { autoVerifyFromMasterlist } from "@/lib/verification";

/** Student accounts whose student number the SSO has not confirmed yet. */
export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  await autoVerifyFromMasterlist().catch(() => 0);
  const rows = await prisma.user.findMany({
    where: { role: "STUDENT", verified: false },
    orderBy: { createdAt: "asc" },
    select: { studentId: true, name: true, email: true, course: true, year: true, approved: true, createdAt: true },
  });
  const sns = rows.map((u) => (u.studentId || "").toUpperCase()).filter(Boolean);
  const listed = sns.length ? await prisma.masterlistEntry.findMany({ where: { sn: { in: sns } }, select: { sn: true, name: true } }) : [];
  const bySn = new Map(listed.map((e) => [e.sn.toUpperCase(), e.name]));
  return NextResponse.json(
    rows.map((u) => ({
      id: u.studentId,
      name: u.name,
      email: u.email,
      course: u.course || "",
      year: u.year || "",
      registered: u.createdAt.toISOString(),
      // Present only when the student number is listed under a different name.
      listedAs: bySn.get((u.studentId || "").toUpperCase()) || "",
    }))
  );
}
