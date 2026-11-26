import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError, parseIntStrict } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const id = decodeURIComponent(params.id);
  const existing = await prisma.complaintCategory.findUnique({ where: { id } });
  if (!existing) return jsonError(404, "Category not found.", "NOT_FOUND");
  const body = await req.json().catch(() => ({}));
  const data: { name?: string; description?: string; active?: boolean; sortOrder?: number } = {};
  if (body?.name !== undefined) {
    const name = String(body.name).trim().replace(/\s+/g, " ").slice(0, 60);
    if (name.length < 2) return jsonError(400, "Category name must be at least 2 characters.", "INVALID_NAME");
    const dup = await prisma.complaintCategory.findFirst({ where: { id: { not: id }, name: { equals: name, mode: "insensitive" } } });
    if (dup) return jsonError(409, "That category already exists.", "DUPLICATE");
    data.name = name;
  }
  if (body?.description !== undefined) data.description = String(body.description).trim().slice(0, 200);
  if (body?.active !== undefined) data.active = body.active === true;
  if (body?.sortOrder !== undefined) {
    const n = parseIntStrict(body.sortOrder, { min: 0, max: 999, field: "Sort order" });
    if (n instanceof NextResponse) return n;
    data.sortOrder = n;
  }
  const row = await prisma.complaintCategory.update({ where: { id }, data });
  // Renaming keeps old complaints readable: move them to the new name.
  if (data.name && data.name !== existing.name) await prisma.complaint.updateMany({ where: { category: existing.name }, data: { category: data.name } });
  await addAudit("INFO", `Complaint category "${existing.name}" updated by ${auth.name}.`);
  return NextResponse.json(row);
}
