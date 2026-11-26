import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { archiveWhere } from "@/lib/archive";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, withTs, withTsList } from "@/lib/format";
import { CONFIDENTIALITY_LEVELS, canViewComplaint, ensureComplaintCategories } from "@/lib/complaints-access";





export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const isStaff = auth.role === "admin" || auth.role === "super_admin";
  const sp = req.nextUrl.searchParams;
  const where: Record<string, unknown> = { ...(isStaff ? {} : { sn: auth.studentId || "" }), ...archiveWhere(req) };
  // Optional filters (staff): confidentiality, category, status.
  const conf = sp.get("confidentiality") || "";
  if (isStaff && (CONFIDENTIALITY_LEVELS as readonly string[]).includes(conf)) where.confidentiality = conf;
  const cat = (sp.get("category") || "").slice(0, 60);
  if (isStaff && cat) where.category = cat;
  const st = (sp.get("status") || "").slice(0, 40);
  if (isStaff && st) where.status = st;
  let rows = await prisma.complaint.findMany({ where, orderBy: { createdAt: "asc" } });
  if (isStaff) {
    // Hidden entirely (lists and counts) when the viewer lacks access.
    rows = rows.filter((c) => canViewComplaint(auth, c));
    return NextResponse.json(withTsList(rows));
  }
  // Students never receive staff-only fields.
  return NextResponse.json(withTsList(rows).map(({ staffNotes: _s, assignedTo: _a, ...rest }: Record<string, unknown>) => rest));
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString().trim();
  const details = (body?.details || "").toString().trim();
  const attName = (body?.attName || "").toString();
  const attUrl = (body?.attUrl || "").toString() || null;
  const confidentiality = (CONFIDENTIALITY_LEVELS as readonly string[]).includes(body?.confidentiality) ? body.confidentiality : "Standard";
  if (!details) return jsonError(400, "Please describe the complaint.", "MISSING_FIELDS");
  await ensureComplaintCategories();
  const validCat = await prisma.complaintCategory.findFirst({ where: { name: category, active: true } });
  if (!validCat) return jsonError(400, "Please choose a valid category.", "INVALID_CATEGORY");

  const created = await prisma.complaint.create({
    data: { id: genId("CMP"), sn: auth.studentId || "", name: auth.name, category, details, attName, attUrl, status: "Submitted", note: "", confidentiality },
  });

  await addAudit("INFO", `Confidential complaint filed (${category}).`);
  await addNotification("admin", "New Complaint", `A confidential ${category} complaint was filed.`);

  return NextResponse.json(withTs(created), { status: 201 });
}
