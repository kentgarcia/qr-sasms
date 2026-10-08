import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/http";


export async function GET() {
  const auth = await requireSession(["admin"]);
  if (auth instanceof NextResponse) return auth;
  const [pendingIdApps, waitingAppointments, openComplaints, emailFailures] = await Promise.all([
    prisma.idApplication.count({ where: { status: "Pending" } }),
    prisma.queueEntry.count({ where: { served: false } }),
    prisma.complaint.count({ where: { status: { in: ["Submitted", "Under Investigation"] } } }),
    prisma.emailLog.count({ where: { mode: "FAILED" } }),
  ]);
  return NextResponse.json({ pendingIdApps, waitingAppointments, openComplaints, emailFailures });
}
