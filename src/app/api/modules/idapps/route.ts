import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, withTs, withTsList } from "@/lib/format";

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const where = auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" };
  const rows = await prisma.idApplication.findMany({ where, orderBy: { createdAt: "asc" } });
  return NextResponse.json(withTsList(rows));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const type = (body?.type || "").toString();
  const reason = (body?.reason || "").toString().trim();
  const orName = (body?.orName || "").toString();
  const orUrl = (body?.orUrl || "").toString();
  const affidavitName = (body?.affidavitName || "").toString();
  const affidavitUrl = (body?.affidavitUrl || "").toString();

  if (!reason) return jsonError(400, "Please provide the reason/details.", "MISSING_FIELDS");
  if (type === "ID Replacement — Lost" && !affidavitUrl) {
    return jsonError(400, "An Affidavit of Loss is required for a lost ID replacement.", "AFFIDAVIT_REQUIRED");
  }

  const created = await prisma.idApplication.create({
    data: { id: genId("IDA"), sn: auth.studentId || "", name: auth.name, type, reason, orName, orUrl, affidavitName: affidavitName || null, affidavitUrl: affidavitUrl || null, status: "Pending", remarks: "" },
  });

  await addAudit("INFO", `ID application (${type}) submitted by ${auth.name}.`);
  await addNotification("admin", "New ID Application", `${auth.name} applied: ${type}.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
