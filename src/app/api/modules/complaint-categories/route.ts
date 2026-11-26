import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { ensureComplaintCategories } from "@/lib/complaints-access";

// Everyone signed in may read the ACTIVE categories (student form + admin filter).
// Super Admin also gets inactive ones with ?all=1 and can create / edit / retire categories.
export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  await ensureComplaintCategories();
  const all = auth.role === "super_admin" && req.nextUrl.searchParams.get("all") === "1";
  const rows = await prisma.complaintCategory.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const description = String(body?.description || "").trim().slice(0, 200);
  if (name.length < 2) return jsonError(400, "Category name must be at least 2 characters.", "INVALID_NAME");
  if (await prisma.complaintCategory.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })) return jsonError(409, "That category already exists.", "DUPLICATE");
  const max = await prisma.complaintCategory.aggregate({ _max: { sortOrder: true } });
  const row = await prisma.complaintCategory.create({ data: { id: `CCAT-${Date.now().toString(36).toUpperCase()}`, name, description, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
  await addAudit("INFO", `Complaint category "${name}" created by ${auth.name}.`);
  return NextResponse.json(row, { status: 201 });
}
