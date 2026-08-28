import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

async function syncExistingCategories() {
  const rows = await prisma.faq.findMany({ distinct: ["cat"], select: { cat: true } });
  const names = rows.map((row) => row.cat.trim()).filter(Boolean);
  if (names.length) await prisma.faqCategory.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
}

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  await syncExistingCategories();
  return NextResponse.json(await prisma.faqCategory.findMany({ orderBy: { name: "asc" } }));
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name) return jsonError(400, "Category name is required.", "MISSING_CATEGORY");
  if (name.length > 80) return jsonError(400, "Category name must be 80 characters or fewer.", "INVALID_CATEGORY");
  try {
    const category = await prisma.faqCategory.create({ data: { name } });
    await addAudit("INFO", `FAQ category added by ${auth.name}.`);
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "P2002") return jsonError(409, "This FAQ category already exists.", "DUPLICATE_CATEGORY");
    return jsonError(500, "Could not add FAQ category.", "CATEGORY_CREATE_FAILED");
  }
}
