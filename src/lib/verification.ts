import { prisma } from "./prisma";
import { addAudit, addNotification } from "./notify";

const tokens = (s: string) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);

/** True when every name part on the account also appears in the masterlist name. */
export function namesAgree(accountName: string, listedName: string): boolean {
  const a = tokens(accountName), b = new Set(tokens(listedName));
  return a.length > 0 && a.every((t) => b.has(t));
}

/**
 * Verify unverified student accounts whose student number now appears in the masterlist
 * with a matching name. Accounts whose name differs are left for manual review.
 * Pass a student number to check a single account.
 */
export async function autoVerifyFromMasterlist(sn?: string): Promise<number> {
  const users = await prisma.user.findMany({
    where: { role: "STUDENT", verified: false, ...(sn ? { studentId: { equals: sn, mode: "insensitive" as const } } : {}) },
    select: { id: true, studentId: true, name: true },
  });
  if (!users.length) return 0;
  const sns = users.map((u) => (u.studentId || "").toUpperCase()).filter(Boolean);
  const entries = await prisma.masterlistEntry.findMany({ where: { sn: { in: sns } }, select: { sn: true, name: true } });
  const bySn = new Map(entries.map((e) => [e.sn.toUpperCase(), e]));
  let n = 0;
  for (const u of users) {
    const e = bySn.get((u.studentId || "").toUpperCase());
    if (!e || (e.name && !namesAgree(u.name, e.name))) continue;
    await prisma.user.update({ where: { id: u.id }, data: { verified: true, verifiedAt: new Date(), verifiedBy: "Masterlist match" } });
    await addAudit("INFO", `Account ${u.studentId} (${u.name}) verified automatically — found in the masterlist.`);
    await addNotification(u.studentId || "", "Account Verified", "Your student number was confirmed. You can now schedule visits and file requests.");
    n++;
  }
  return n;
}
