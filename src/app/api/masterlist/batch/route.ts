import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { normSN } from "@/lib/format";
import { masterlistValidationError } from "@/lib/masterlist-validation";

type BatchRow = {
  sn: string;
  name: string;
  email: string;
  course: string;
  year: string;
  schoolYear: string;
};

export type BatchRowResult = BatchRow & {
  index: number;
  status: "ready" | "conflict";
  reason: string | null;
  code:
    | "OK"
    | "INVALID"
    | "DUPLICATE_IN_FILE"
    | "SN_EXISTS"
    | "ALREADY_REGISTERED"
    | "EMAIL_TAKEN";
};

const MAX_BATCH_ROWS = 2000;

function cleanRow(r: unknown): BatchRow {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  return {
    sn: normSN(o?.sn as string),
    name: (o?.name ?? "").toString().trim(),
    email: (o?.email ?? "").toString().trim(),
    course: (o?.course ?? "").toString().trim(),
    year: (o?.year ?? "").toString().trim(),
    schoolYear: (o?.schoolYear ?? "").toString().trim(),
  };
}

/**
 * Additive bulk-add for Masterlist Manager.
 * Body: { rows: BatchRow[], dryRun?: boolean, fileName?: string }
 * - dryRun=true (default): validate + check conflicts, no DB writes.
 * - dryRun=false: insert only clean rows, report skipped conflicts.
 * Unlike /api/masterlist/import this never deletes existing entries.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const rawRows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rawRows || !rawRows.length) {
    return jsonError(400, "No rows to add. Upload a filled template first.", "EMPTY_BATCH");
  }
  if (rawRows.length > MAX_BATCH_ROWS) {
    return jsonError(400, `Too many rows (${rawRows.length}). Maximum ${MAX_BATCH_ROWS} per upload.`, "BATCH_TOO_LARGE");
  }
  const dryRun = body?.dryRun !== false;

  const cleaned: BatchRow[] = rawRows.map(cleanRow);

  // Duplicate SNs inside the uploaded file.
  const snCounts = new Map<string, number>();
  for (const r of cleaned) {
    if (!r.sn) continue;
    snCounts.set(r.sn, (snCounts.get(r.sn) ?? 0) + 1);
  }
  // Duplicate emails inside the uploaded file (case-insensitive).
  const emailCounts = new Map<string, number>();
  for (const r of cleaned) {
    const key = r.email.trim().toLowerCase();
    if (!key) continue;
    emailCounts.set(key, (emailCounts.get(key) ?? 0) + 1);
  }

  const sns = [...new Set(cleaned.map((r) => r.sn).filter(Boolean))];
  const emails = [...new Set(cleaned.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];

  const [existingEntries, existingUsersBySn, existingUsersByEmail, existingEmailsInMasterlist] =
    await Promise.all([
      sns.length
        ? prisma.masterlistEntry.findMany({ where: { sn: { in: sns } }, select: { sn: true } })
        : Promise.resolve([]),
      sns.length
        ? prisma.user.findMany({ where: { studentId: { in: sns } }, select: { studentId: true } })
        : Promise.resolve([]),
      emails.length
        ? prisma.user.findMany({
            where: { email: { in: emails, mode: "insensitive" } },
            select: { email: true },
          })
        : Promise.resolve([]),
      emails.length
        ? prisma.masterlistEntry.findMany({
            where: { email: { in: cleaned.map((r) => r.email).filter(Boolean), mode: "insensitive" } },
            select: { email: true },
          })
        : Promise.resolve([]),
    ]);

  const takenSn = new Set(existingEntries.map((e) => normSN(e.sn)));
  const registeredSn = new Set(
    existingUsersBySn.map((u) => normSN(u.studentId ?? ""))
  );
  const takenEmail = new Set([
    ...existingUsersByEmail.map((u) => u.email.trim().toLowerCase()),
    ...existingEmailsInMasterlist.map((e) => e.email.trim().toLowerCase()),
  ]);

  const results: BatchRowResult[] = cleaned.map((row, index) => {
    const validationError = row.sn
      ? masterlistValidationError(row)
      : "Student number is required.";
    if (validationError) {
      return { ...row, index, status: "conflict", reason: validationError, code: "INVALID" };
    }
    if ((snCounts.get(row.sn) ?? 0) > 1) {
      return {
        ...row,
        index,
        status: "conflict",
        reason: `Duplicate student number in this file: ${row.sn}.`,
        code: "DUPLICATE_IN_FILE",
      };
    }
    if ((emailCounts.get(row.email.trim().toLowerCase()) ?? 0) > 1) {
      return {
        ...row,
        index,
        status: "conflict",
        reason: `Duplicate email in this file: ${row.email}.`,
        code: "DUPLICATE_IN_FILE",
      };
    }
    if (takenSn.has(row.sn)) {
      return {
        ...row,
        index,
        status: "conflict",
        reason: `${row.sn} is already in the masterlist.`,
        code: "SN_EXISTS",
      };
    }
    if (registeredSn.has(row.sn)) {
      return {
        ...row,
        index,
        status: "conflict",
        reason: `${row.sn} already has a registered student account.`,
        code: "ALREADY_REGISTERED",
      };
    }
    if (takenEmail.has(row.email.trim().toLowerCase())) {
      return {
        ...row,
        index,
        status: "conflict",
        reason: `Email ${row.email} is already used by another record.`,
        code: "EMAIL_TAKEN",
      };
    }
    return { ...row, index, status: "ready", reason: null, code: "OK" };
  });

  const ready = results.filter((r) => r.status === "ready");
  const conflicts = results.filter((r) => r.status === "conflict");

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      total: results.length,
      readyCount: ready.length,
      conflictCount: conflicts.length,
      rows: results,
    });
  }

  if (!ready.length) {
    return jsonError(400, "No valid rows to add — every row has a conflict.", "ALL_CONFLICT");
  }

  await prisma.masterlistEntry.createMany({
    data: ready.map(({ index: _i, status: _s, reason: _r, code: _c, ...data }) => data),
    skipDuplicates: true,
  });
  await addAudit(
    "INFO",
    `Masterlist bulk-add by ${auth.email} — ${ready.length} added, ${conflicts.length} skipped${body?.fileName ? ` from "${body.fileName}"` : ""}.`
  );

  return NextResponse.json(
    {
      dryRun: false,
      total: results.length,
      added: ready.length,
      skipped: conflicts.length,
      rows: results,
    },
    { status: 201 }
  );
}
