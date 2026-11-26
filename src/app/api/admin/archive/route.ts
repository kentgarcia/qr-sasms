import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonError, parseIntStrict } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { prisma } from "@/lib/prisma";
import { getArchiveDays, runArchive } from "@/lib/archive";

// Super Admin only. GET = current retention + dry-run counts. PUT = save retention days. POST = run archive now.
export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const preview = await runArchive({ dryRun: true });
  const archived = {
    complaints: await prisma.complaint.count({ where: { archivedAt: { not: null } } }),
    requests: await prisma.serviceRequest.count({ where: { archivedAt: { not: null } } }),
    idApplications: await prisma.idApplication.count({ where: { archivedAt: { not: null } } }),
    eventRequests: await prisma.eventRequest.count({ where: { archivedAt: { not: null } } }),
    referrals: await prisma.referral.count({ where: { archivedAt: { not: null } } }),
    appointments: await prisma.queueEntry.count({ where: { archivedAt: { not: null } } }),
    tickets: await prisma.ticket.count({ where: { archivedAt: { not: null } } }),
  };
  return NextResponse.json({ days: await getArchiveDays(), due: preview.counts, dueTotal: preview.total, archived });
}

export async function PUT(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const days = parseIntStrict(body?.days, { min: 7, max: 365, field: "Archive after (days)", code: "INVALID_ARCHIVE_DAYS" });
  if (days instanceof NextResponse) return days;
  await prisma.systemSetting.upsert({ where: { key: "archiveAfterDays" }, update: { value: String(days) }, create: { key: "archiveAfterDays", value: String(days) } });
  await addAudit("INFO", `Archive retention set to ${days} days by ${auth.name}.`);
  return NextResponse.json({ days });
}

export async function POST() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  try {
    const result = await runArchive();
    return NextResponse.json(result);
  } catch {
    return jsonError(500, "Archive run failed.", "ARCHIVE_FAILED");
  }
}
