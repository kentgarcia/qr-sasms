import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

const restoreDate = (value: unknown) => value ? new Date(String(value)) : undefined;
const rows = (value: unknown) => Array.isArray(value) ? value : [];
const dateRows = (value: unknown, names = ["createdAt"]) => rows(value).map((raw) => {
  const row = { ...(raw as Record<string, unknown>) };
  names.forEach((name) => { if (row[name]) row[name] = restoreDate(row[name]); });
  return row;
});



export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const [users, appointments, complaints, masterlist, masterlistGroups, settings, faqs, referrals, idApplications, bulletins, tickets, events, forms, memos, notifications, emails, audits, profileChanges, feedback, reminders] = await Promise.all([
    prisma.user.findMany(), prisma.queueEntry.findMany(), prisma.complaint.findMany(), prisma.masterlistEntry.findMany(), prisma.masterlistGroup.findMany(), prisma.systemSetting.findMany(), prisma.faq.findMany(), prisma.referral.findMany(), prisma.idApplication.findMany(), prisma.bulletin.findMany(), prisma.ticket.findMany(), prisma.eventRequest.findMany(), prisma.downloadableForm.findMany(), prisma.memo.findMany(), prisma.notification.findMany(), prisma.emailLog.findMany(), prisma.auditLog.findMany(), prisma.profileChange.findMany(), prisma.serviceFeedback.findMany(), prisma.reminderLog.findMany(),
  ]);
  await addAudit("INFO", `Full database backup exported by ${auth.name}.`);
  return NextResponse.json({ exportedAt: new Date().toISOString(), version: 2, users, appointments, complaints, masterlist, masterlistGroups, settings, faqs, referrals, idApplications, bulletins, tickets, events, forms, memos, notifications, emails, audits, profileChanges, feedback, reminders }, { headers: { "Content-Disposition": `attachment; filename=\"stars-full-backup-${new Date().toISOString().slice(0, 10)}.json\"`, "Cache-Control": "no-store" } });
}



export async function POST(req: Request) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const backup = body?.backup;
  if (body?.confirmation !== "RESTORE ALL DATA") return jsonError(400, "Confirmation phrase is required.", "RESTORE_CONFIRMATION_REQUIRED");
  if (!backup || backup.version !== 2 || !Array.isArray(backup.users) || !Array.isArray(backup.appointments)) return jsonError(400, "Invalid full STARS backup file.", "INVALID_BACKUP");
  if (!backup.users.some((user: Record<string, unknown>) => String(user.role) === "SUPER_ADMIN" && user.active !== false)) return jsonError(400, "The backup must contain an active Super Admin account.", "NO_SUPER_ADMIN");

  const users = dateRows(backup.users);
  const appointments = dateRows(backup.appointments);
  const complaints = dateRows(backup.complaints);
  const masterlist = dateRows(backup.masterlist);
  const masterlistGroups = dateRows(backup.masterlistGroups, ["createdAt", "updatedAt"]);
  const settings = dateRows(backup.settings, ["updatedAt"]);
  const faqs = dateRows(backup.faqs);
  const referrals = dateRows(backup.referrals);
  const idApplications = dateRows(backup.idApplications);
  const bulletins = dateRows(backup.bulletins, ["createdAt", "publishAt", "updatedTs"]);
  const tickets = dateRows(backup.tickets);
  const events = dateRows(backup.events);
  const forms = dateRows(backup.forms);
  const memos = dateRows(backup.memos);
  const notifications = dateRows(backup.notifications);
  const emails = dateRows(backup.emails);
  const audits = dateRows(backup.audits);
  const profileChanges = dateRows(backup.profileChanges);
  const feedback = dateRows(backup.feedback);
  const reminders = dateRows(backup.reminders);

  await prisma.$transaction(async (tx) => {
    await Promise.all([tx.reminderLog.deleteMany(), tx.serviceFeedback.deleteMany(), tx.profileChange.deleteMany(), tx.auditLog.deleteMany(), tx.emailLog.deleteMany(), tx.notification.deleteMany(), tx.memo.deleteMany(), tx.downloadableForm.deleteMany(), tx.eventRequest.deleteMany(), tx.ticket.deleteMany(), tx.bulletin.deleteMany(), tx.idApplication.deleteMany(), tx.referral.deleteMany(), tx.faq.deleteMany(), tx.systemSetting.deleteMany(), tx.masterlistGroup.deleteMany(), tx.masterlistEntry.deleteMany(), tx.complaint.deleteMany(), tx.queueEntry.deleteMany(), tx.user.deleteMany()]);
    if (users.length) await tx.user.createMany({ data: users as never });
    if (appointments.length) await tx.queueEntry.createMany({ data: appointments as never });
    if (complaints.length) await tx.complaint.createMany({ data: complaints as never });
    if (masterlist.length) await tx.masterlistEntry.createMany({ data: masterlist as never });
    if (masterlistGroups.length) await tx.masterlistGroup.createMany({ data: masterlistGroups as never });
    if (settings.length) await tx.systemSetting.createMany({ data: settings as never });
    if (faqs.length) await tx.faq.createMany({ data: faqs as never });
    if (referrals.length) await tx.referral.createMany({ data: referrals as never });
    if (idApplications.length) await tx.idApplication.createMany({ data: idApplications as never });
    if (bulletins.length) await tx.bulletin.createMany({ data: bulletins as never });
    if (tickets.length) await tx.ticket.createMany({ data: tickets as never });
    if (events.length) await tx.eventRequest.createMany({ data: events as never });
    if (forms.length) await tx.downloadableForm.createMany({ data: forms as never });
    if (memos.length) await tx.memo.createMany({ data: memos as never });
    if (notifications.length) await tx.notification.createMany({ data: notifications as never });
    if (emails.length) await tx.emailLog.createMany({ data: emails as never });
    if (audits.length) await tx.auditLog.createMany({ data: audits as never });
    if (profileChanges.length) await tx.profileChange.createMany({ data: profileChanges as never });
    if (feedback.length) await tx.serviceFeedback.createMany({ data: feedback as never });
    if (reminders.length) await tx.reminderLog.createMany({ data: reminders as never });
  }, { timeout: 30000 });
  await addAudit("WARN", `Full database restored by ${auth.name}. Backup exported at ${backup.exportedAt || "unknown time"}.`);
  return NextResponse.json({ ok: true, restored: { users: users.length, appointments: appointments.length, complaints: complaints.length } });
}
