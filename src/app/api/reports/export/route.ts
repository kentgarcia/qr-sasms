import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";

function csvCell(value: unknown) {
  const text = String(value ?? "").replace(/"/g, '""');
  
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe}"`;
}

function csv(headers: string[], rows: unknown[][]) {
  return [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const type = req.nextUrl.searchParams.get("type") || "appointments";
  let data = "";
  if (type === "appointments") {
    const rows = await prisma.queueEntry.findMany({ orderBy: { createdAt: "desc" } });
    const { serviceLabel, normalizeStatus } = await import("@/lib/appointments");
    data = csv(
      ["Appointment Number", "Student Number", "Student", "Date", "Time", "Service", "Linked Ref", "Purpose", "Copies", "Notes", "Status", "Booked At"],
      rows.map((r) => [
        r.code, r.studentId, r.name,
        r.dateLabel, r.time, serviceLabel(r.serviceType), r.serviceRefId, r.purpose, r.copies, r.notes, normalizeStatus(r.status), r.createdAt.toISOString(),
      ])
    );
  } else if (type === "complaints") {
    const rows = await prisma.complaint.findMany({ orderBy: { createdAt: "desc" } });
    data = csv(["Reference", "Student Number", "Complainant", "Category", "Confidentiality", "Assigned To", "Status", "Submitted"], rows.map((r) => [r.id, r.sn, r.name, r.category, r.confidentiality, r.assignedTo, r.status, r.createdAt.toISOString()]));
  } else return jsonError(400, "Unsupported report type.", "INVALID_REPORT_TYPE");

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(data, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="stars-${type}-${date}.csv"`, "Cache-Control": "no-store" } });
}
