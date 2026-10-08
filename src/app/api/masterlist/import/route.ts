import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { isValidSchoolYear, masterlistValidationError } from "@/lib/masterlist-validation";









export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || !rows.length) {
    return jsonError(400, "No valid student numbers found in the CSV.", "EMPTY_CSV");
  }

  const scope = body?.scope && typeof body.scope === "object" ? body.scope : null;
  const scopeSchoolYear = scope ? (scope.schoolYear || "").toString().trim() : "";
  const scopeCourse = scope ? (scope.course || "").toString().trim() : "";
  const scopeYear = scope ? (scope.year || "").toString().trim() : "";
  if (scope && (!scopeSchoolYear || !scopeCourse || !scopeYear)) {
    return jsonError(400, "A scoped import needs a school year, course, and year level.", "INVALID_SCOPE");
  }
  if (scope && !isValidSchoolYear(scopeSchoolYear)) {
    return jsonError(400, "School year must use consecutive years in YYYY-YYYY format (example: 2026-2027).", "INVALID_SCHOOL_YEAR");
  }

  const seen = new Set<string>();
  const clean: { sn: string; name: string; email: string; course: string; year: string; schoolYear: string }[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const r = rows[index];
    const sn = normSN(r?.sn);
    if (seen.has(sn)) return jsonError(400, `Duplicate student number in CSV: ${sn}.`, "DUPLICATE_STUDENT_NUMBER");
    const value = {
      sn,
      name: (r?.name || "").toString().trim(),
      email: (r?.email || "").toString().trim(),
      course: scope ? scopeCourse : (r?.course || "").toString().trim(),
      year: scope ? scopeYear : (r?.year || "").toString().trim(),
      schoolYear: scope ? scopeSchoolYear : (r?.schoolYear || "").toString().trim(),
    };
    const validationError = masterlistValidationError(value);
    if (validationError) return jsonError(400, `CSV row ${index + 1}: ${validationError}`, "INVALID_CSV_ROW");
    seen.add(sn);
    clean.push(value);
  }
  if (!clean.length) {
    return jsonError(400, "No valid student numbers found in the CSV.", "EMPTY_CSV");
  }

  await prisma.$transaction([
    scope
      ? prisma.masterlistEntry.deleteMany({ where: { schoolYear: scopeSchoolYear, course: scopeCourse, year: scopeYear } })
      : prisma.masterlistEntry.deleteMany({}),
    prisma.masterlistEntry.createMany({ data: clean }),
  ]);

  await addAudit(
    "INFO",
    scope
      ? `Masterlist group ${scopeSchoolYear} · ${scopeCourse} · ${scopeYear} imported — ${clean.length} students from "${body?.fileName || "upload"}".`
      : `Masterlist imported — ${clean.length} students from "${body?.fileName || "upload"}".`
  );

  return NextResponse.json({ count: clean.length });
}
