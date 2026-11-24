import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { serviceLabel, normalizeStatus } from "@/lib/appointments";
import { requestServiceLabel } from "@/lib/service-requests";
import { fnow } from "@/lib/format";

function csvCell(value: unknown) {
  const text = String(value ?? "").replace(/"/g, '""');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe}"`;
}

function csv(headers: string[], rows: unknown[][]) {
  return [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
}

function parseDateBounds(fromParam: string | null, toParam: string | null) {
  const from = fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : null;
  const to = toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam) ? toParam : null;
  const createdAt: { gte?: Date; lte?: Date } = {};
  if (from) {
    const d = new Date(`${from}T00:00:00+08:00`);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999+08:00`);
    if (!Number.isNaN(d.getTime())) createdAt.lte = d;
  }
  return {
    from,
    to,
    where: Object.keys(createdAt).length ? { createdAt } : undefined,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const type = (req.nextUrl.searchParams.get("type") || "appointments").toLowerCase();
  const { from, to, where } = parseDateBounds(
    req.nextUrl.searchParams.get("from"),
    req.nextUrl.searchParams.get("to")
  );

  let data = "";

  if (type === "appointments") {
    const rows = await prisma.queueEntry.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Appointment Number", "Student Number", "Student", "Date", "Time", "Service", "Linked Ref", "Purpose", "Copies", "Booked By", "Notes", "Status", "Booked At (PHT)"],
      rows.map((r) => [
        r.code,
        r.studentId,
        r.name,
        r.dateLabel,
        r.time,
        serviceLabel(r.serviceType),
        r.serviceRefId || "",
        r.purpose,
        r.copies,
        r.bookedBy || "Student",
        r.notes,
        normalizeStatus(r.status),
        fnow(r.createdAt),
      ])
    );
  } else if (type === "requests") {
    const rows = await prisma.serviceRequest.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Reference", "Student Number", "Student", "Service", "Subject", "Copies", "Status", "Appointment Code", "Pickup / Visit Date", "Time", "Remarks", "Filed At (PHT)", "Completed At (PHT)"],
      rows.map((r) => [
        r.id,
        r.sn,
        r.name,
        requestServiceLabel(r.service),
        r.subject,
        r.copies,
        r.status,
        r.appointmentCode || "",
        r.pickupDate || r.dateLabel || "",
        r.pickupTime || r.time || "",
        r.remarks,
        fnow(r.createdAt),
        r.pickedUpAt ? fnow(r.pickedUpAt) : "",
      ])
    );
  } else if (type === "idapps") {
    const rows = await prisma.idApplication.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Reference", "Student Number", "Student", "Type", "Reason", "Status", "Pickup Date", "Pickup Time", "Remarks", "Filed At (PHT)", "Claimed At (PHT)"],
      rows.map((r) => [
        r.id,
        r.sn,
        r.name,
        r.type,
        r.reason,
        r.status,
        r.pickupDate,
        r.pickupTime,
        r.remarks,
        fnow(r.createdAt),
        r.pickedUpAt ? fnow(r.pickedUpAt) : "",
      ])
    );
  } else if (type === "events") {
    const rows = await prisma.eventRequest.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Reference", "Student Number", "Representative", "Organization", "Title", "Adviser", "Event Date", "Event Time", "Venue", "Participants", "Budget", "Status", "Appointment Code", "Submitted At (PHT)"],
      rows.map((r) => [
        r.id,
        r.sn,
        r.name,
        r.org,
        r.title,
        r.adviser,
        r.date,
        r.time,
        r.venue,
        r.participants,
        r.budget,
        r.status,
        r.appointmentCode || "",
        fnow(r.createdAt),
      ])
    );
  } else if (type === "referrals") {
    const rows = await prisma.referral.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Reference", "Student Number", "Student", "Category", "Status", "Appointment Code", "Appointment Date", "Appointment Time", "Remarks", "Submitted At (PHT)"],
      rows.map((r) => [
        r.id,
        r.sn,
        r.name,
        r.category,
        r.status,
        r.appointmentCode || "",
        r.appointmentDate,
        r.appointmentTime,
        r.remarks,
        fnow(r.createdAt),
      ])
    );
  } else if (type === "complaints") {
    const rows = await prisma.complaint.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["Reference", "Student Number", "Complainant", "Category", "Confidentiality", "Assigned To", "Status", "Submitted At (PHT)"],
      rows.map((r) => [r.id, r.sn, r.name, r.category, r.confidentiality, r.assignedTo || "", r.status, fnow(r.createdAt)])
    );
  } else if (type === "feedback") {
    const rows = await prisma.serviceFeedback.findMany({ where, orderBy: { createdAt: "desc" } });
    data = csv(
      ["ID", "Transaction Ref", "Student Number", "Rating (1-5)", "Comment", "Submitted At (PHT)"],
      rows.map((r) => [r.id, r.requestId, r.studentId, r.rating, r.comment, fnow(r.createdAt)])
    );
  } else if (type === "audit") {
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 5000 });
    data = csv(
      ["Timestamp (PHT)", "Severity", "Message"],
      rows.map((r) => [fnow(r.createdAt), r.type, r.msg])
    );
  } else {
    return jsonError(
      400,
      "Unsupported report type. Use appointments, requests, idapps, events, referrals, complaints, feedback, or audit.",
      "INVALID_REPORT_TYPE"
    );
  }

  const dateTag = from || to ? `${from || "start"}_to_${to || "now"}` : new Date().toISOString().slice(0, 10);
  return new NextResponse(data, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stars-${type}-${dateTag}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
