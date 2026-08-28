import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const category = await prisma.faqCategory.findUnique({ where: { id } });
  if (!category) return jsonError(404, "FAQ category not found.", "NOT_FOUND");

  const result = await prisma.$transaction(async (tx) => {
    const removedFaqs = await tx.faq.deleteMany({ where: { cat: category.name } });
    await tx.faqCategory.delete({ where: { id } });
    return removedFaqs.count;
  });
  await addAudit("WARN", `FAQ category '${category.name}' and ${result} FAQ(s) deleted by ${auth.name}.`);
  return NextResponse.json({ ok: true, removedFaqs: result });
}
