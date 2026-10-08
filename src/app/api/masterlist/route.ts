import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { masterlistValidationError } from "@/lib/masterlist-validation";




export async function GET(req: NextRequest) {
  const full = req.nextUrl.searchParams.get("full");
  if (!full) {
    const count = await prisma.masterlistEntry.count();
    return NextResponse.json({ count });
  }
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.masterlistEntry.findMany({ orderBy: { sn: "asc" } });
  // Link each masterlist entry to its registered student account (if any).
  const sns = [...new Set(rows.map((r) => r.sn))];
  const users = sns.length
    ? await prisma.user.findMany({
        where: { studentId: { in: sns } },
        select: { studentId: true, name: true, email: true, active: true, approved: true },
      })
    : [];
  const bySn = new Map(
    users.map((u) => [(u.studentId || "").trim().toUpperCase(), u])
  );
  return NextResponse.json(
    rows.map((r) => {
      const account = bySn.get(r.sn.trim().toUpperCase()) ?? null;
      return { ...r, account, registered: !!account };
    })
  );
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const values = {
    sn: normSN(body?.sn),
    name: (body?.name || "").toString().trim(),
    email: (body?.email || "").toString().trim(),
    course: (body?.course || "").toString().trim(),
    year: (body?.year || "").toString().trim(),
    schoolYear: (body?.schoolYear || "").toString().trim(),
  };
  const validationError = masterlistValidationError(values);
  if (validationError) return jsonError(400, validationError, "INVALID_MASTERLIST_ENTRY");
  const sn = values.sn;

  const existing = await prisma.masterlistEntry.findUnique({ where: { sn } });
  if (existing) return jsonError(409, `${sn} is already in the masterlist.`, "SN_EXISTS");

  const entry = await prisma.masterlistEntry.create({
    data: {
      ...values,
    },
  });
  await addAudit("INFO", `Masterlist entry ${sn} added by ${auth.email}.`);
  return NextResponse.json(entry, { status: 201 });
}
export async function DELETE() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const { count } = await prisma.masterlistEntry.deleteMany({});
  await addAudit("WARN", `Masterlist cleared by ${auth.email} — ${count} imported student${count === 1 ? "" : "s"} removed.`);

  return NextResponse.json({ ok: true, count });
}
