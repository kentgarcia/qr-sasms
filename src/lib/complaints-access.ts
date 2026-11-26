import { prisma } from "./prisma";

export const CONFIDENTIALITY_LEVELS = ["Standard", "Restricted", "Strictly Confidential"] as const;
export const DEFAULT_COMPLAINT_CATEGORIES = ["Facilities", "Staff Conduct", "Academic Concern", "Harassment / Bullying", "Safety & Security", "Others"];

type Viewer = { role: string; name: string };

/**
 * Who may open a complaint:
 *  - Standard: any admin
 *  - Restricted: the assigned admin, or a super admin
 *  - Strictly Confidential: super admin only
 */
export function canViewComplaint(viewer: Viewer, c: { confidentiality: string; assignedTo: string | null }): boolean {
  if (viewer.role === "super_admin") return true;
  if (viewer.role !== "admin") return false;
  if (c.confidentiality === "Strictly Confidential") return false;
  if (c.confidentiality === "Restricted") return !!c.assignedTo && c.assignedTo.trim().toLowerCase() === viewer.name.trim().toLowerCase();
  return true;
}

/** Seeds the default categories the first time the table is used. */
export async function ensureComplaintCategories() {
  if ((await prisma.complaintCategory.count()) > 0) return;
  await prisma.complaintCategory.createMany({
    data: DEFAULT_COMPLAINT_CATEGORIES.map((name, i) => ({ id: `CCAT-${i + 1}`, name, sortOrder: i })),
    skipDuplicates: true,
  });
}
