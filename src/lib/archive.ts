import type { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { addAudit } from "./notify";

// Statuses that mean a record is finished. Only these are ever auto-archived,
// so an open request or complaint never disappears from a student's list.
export const TERMINAL_STATUSES = [
  "completed", "claimed", "cancelled", "canceled", "rejected",
  "resolved", "closed", "dismissed", "served", "no_show", "no show",
];

export const DEFAULT_ARCHIVE_DAYS = 30;

/** Prisma `where` fragment for list endpoints: active by default, `?archived=1` for archived only. */
export function archiveWhere(req: NextRequest): { archivedAt: null | { not: null } } {
  const v = req.nextUrl.searchParams.get("archived");
  return v === "1" || v === "true" ? { archivedAt: { not: null } } : { archivedAt: null };
}

export async function getArchiveDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "archiveAfterDays" } });
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 7 && n <= 365 ? n : DEFAULT_ARCHIVE_DAYS;
}

type Counts = Record<string, number>;

/**
 * Archives terminal-status records older than the retention window.
 * Idempotent: rows already archived are skipped. `dryRun` only counts.
 * Age is measured from updatedAt where the model has one, else createdAt.
 */
export async function runArchive(opts: { dryRun?: boolean; days?: number } = {}): Promise<{ days: number; cutoff: string; dryRun: boolean; counts: Counts; total: number }> {
  const days = opts.days ?? (await getArchiveDays());
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const dryRun = !!opts.dryRun;
  const statusIn = { in: TERMINAL_STATUSES, mode: "insensitive" as const };
  const base = { archivedAt: null };
  const jobs: Array<[string, () => Promise<number>]> = [
    ["complaints", () => run(prisma.complaint, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
    ["serviceRequests", () => run(prisma.serviceRequest, { ...base, status: statusIn, updatedAt: { lt: cutoff } })],
    ["idApplications", () => run(prisma.idApplication, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
    ["eventRequests", () => run(prisma.eventRequest, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
    ["referrals", () => run(prisma.referral, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
    ["appointments", () => run(prisma.queueEntry, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
    ["tickets", () => run(prisma.ticket, { ...base, status: statusIn, createdAt: { lt: cutoff } })],
  ];
  async function run(model: any, where: Record<string, unknown>): Promise<number> {
    if (dryRun) return model.count({ where });
    return (await model.updateMany({ where, data: { archivedAt: new Date() } })).count;
  }
  const counts: Counts = {};
  let total = 0;
  for (const [name, job] of jobs) { counts[name] = await job(); total += counts[name]; }
  if (!dryRun) await addAudit("INFO", `Auto-archive (> ${days} days): ${total} record(s) archived. ${JSON.stringify(counts)}`);
  return { days, cutoff: cutoff.toISOString(), dryRun, counts, total };
}
