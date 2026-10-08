import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";
import { addAudit } from "@/lib/notify";
import { sendDueEmailReminders } from "@/lib/reminders";


export async function POST() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const { appointmentEmails, readyEmails } = await sendDueEmailReminders();
  await addAudit("INFO", `Reminders sent by ${auth.name}: ${appointmentEmails} appointment.`);
  return NextResponse.json({ appointmentEmails, readyEmails });
}
