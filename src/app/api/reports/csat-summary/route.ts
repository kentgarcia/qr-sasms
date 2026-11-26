import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";

// Compact CSAT numbers for the admin dashboard card: last 30 days vs the 30 before.
export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const now = Date.now(), d30 = new Date(now - 30 * 86_400_000), d60 = new Date(now - 60 * 86_400_000);
  const [cur, prev] = await Promise.all([
    prisma.serviceFeedback.findMany({ where: { createdAt: { gte: d30 } }, select: { rating: true } }),
    prisma.serviceFeedback.findMany({ where: { createdAt: { gte: d60, lt: d30 } }, select: { rating: true } }),
  ]);
  const avg = (rows: { rating: number }[]) => (rows.length ? Math.round((rows.reduce((a, r) => a + Math.min(5, Math.max(1, r.rating)), 0) / rows.length) * 100) / 100 : 0);
  const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: cur.filter((r) => Math.round(r.rating) === star).length }));
  return NextResponse.json({ days: 30, total: cur.length, average: avg(cur), previousAverage: avg(prev), previousTotal: prev.length, distribution });
}
