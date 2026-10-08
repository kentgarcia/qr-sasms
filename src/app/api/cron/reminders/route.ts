import { NextRequest, NextResponse } from "next/server";
import { sendDueEmailReminders } from "@/lib/reminders";
import { addAudit } from "@/lib/notify";



export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await sendDueEmailReminders();
  await addAudit("INFO", `Scheduled email reminders sent: ${result.appointmentEmails} appointment.`);
  return NextResponse.json(result);
}
