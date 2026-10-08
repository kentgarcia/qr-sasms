import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  await prisma.auditLog.create({ data: { type: "INFO", msg: `FAQ_CHATBOT_QUERY:${String(body?.faqId || "unmatched")}` } });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const logs = await prisma.auditLog.findMany({ where: { msg: { startsWith: "FAQ_CHATBOT_QUERY:" } } });
  const counts = logs.reduce<Record<string, number>>((out, log) => { const key = log.msg.split(":")[1] || "unmatched"; out[key] = (out[key] || 0) + 1; return out; }, {});
  const faqs = await prisma.faq.findMany({ select: { id: true, q: true } });
  return NextResponse.json({ totalQueries: logs.length, matches: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ question: faqs.find((f) => f.id === id)?.q || "Unmatched questions", count })) });
}
