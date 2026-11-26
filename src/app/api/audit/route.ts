import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";
import { fnow } from "@/lib/format";

// Legacy: last 200 entries (admin). Paged mode (`?paged=1`, Super Admin only) adds
// filters: level, q (text), from / to (YYYY-MM-DD), page, pageSize (max 100).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get("paged") === "1") {
    const auth = await requireSession(["super_admin"]);
    if (auth instanceof NextResponse) return auth;
    const level = (sp.get("level") || "").toUpperCase();
    const q = (sp.get("q") || "").trim().slice(0, 100);
    const where: Record<string, unknown> = {};
    if (["INFO", "WARN", "ERROR"].includes(level)) where.type = level;
    if (q) where.msg = { contains: q, mode: "insensitive" };
    const range: Record<string, Date> = {};
    const from = sp.get("from"), to = sp.get("to");
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) range.gte = new Date(`${from}T00:00:00+08:00`);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) range.lte = new Date(`${to}T23:59:59.999+08:00`);
    if (Object.keys(range).length) where.createdAt = range;
    const order = sp.get("order") === "asc" ? "asc" : "desc";
    // CSV export of everything matching the filters (capped).
    if (sp.get("export") === "1") {
      const all = await prisma.auditLog.findMany({ where, orderBy: { createdAt: order }, take: 5000 });
      return NextResponse.json({ rows: all.map((l) => ({ type: l.type, ts: fnow(l.createdAt), msg: l.msg })) });
    }
    const pageSize = Math.min(100, Math.max(5, parseInt(sp.get("pageSize") || "25", 10) || 25));
    const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
    // Per-level counts ignore the level filter so the tabs always show the full picture for the other filters.
    const { type: _level, ...whereNoLevel } = where;
    void _level;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [total, rows, grouped, recent] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: order }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditLog.groupBy({ by: ["type"], where: whereNoLevel, _count: { _all: true } }),
      prisma.auditLog.findMany({ where: { createdAt: { gte: since } }, select: { type: true, createdAt: true }, take: 5000 }),
    ]);
    // 24 hourly buckets (oldest → newest) for the activity sparkline.
    const hourly = Array.from({ length: 24 }, () => ({ INFO: 0, WARN: 0, ERROR: 0 }));
    for (const r of recent) {
      const idx = 23 - Math.floor((Date.now() - r.createdAt.getTime()) / 3600000);
      if (idx >= 0 && idx < 24 && r.type in hourly[idx]) hourly[idx][r.type as "INFO" | "WARN" | "ERROR"]++;
    }
    const counts: Record<string, number> = { INFO: 0, WARN: 0, ERROR: 0 };
    for (const g of grouped) counts[g.type] = g._count._all;
    return NextResponse.json({ total, page, pageSize, counts, hourly, last24h: recent.length, rows: rows.map((l) => ({ type: l.type, ts: fnow(l.createdAt), msg: l.msg })) });
  }

  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return NextResponse.json(rows.map((l) => ({ type: l.type, ts: fnow(l.createdAt), msg: l.msg })).reverse());
}
