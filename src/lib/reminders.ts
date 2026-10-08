import { prisma } from "@/lib/prisma";
import { notifyStudentByEmail } from "@/lib/notify";

function appointmentDate(dateLabel: string, time: string) { return new Date(`${dateLabel} ${time}`); }


export async function sendDueEmailReminders() {
  const now = Date.now(); const tomorrow = now + 24 * 60 * 60 * 1000;
  const appointments = await prisma.queueEntry.findMany({ where: { status: { in: ["BOOKED", "RESCHEDULED", "CHECKED_IN"] } } });
  let appointmentEmails = 0;
  for (const appointment of appointments) {
    const scheduled = appointmentDate(appointment.dateLabel, appointment.time).getTime();
    if (scheduled >= now && scheduled <= tomorrow) {
      const reminderKey = `appointment:${appointment.code}`;
      if (await prisma.reminderLog.findUnique({ where: { reminderKey } })) continue;
      await notifyStudentByEmail({ studentId: appointment.studentId, name: appointment.name, title: "Appointment Reminder", message: `Reminder: you have appointment ${appointment.code} within the next 24 hours at ${appointment.time} (${appointment.dateLabel}).`, ref: appointment.code });
      await prisma.reminderLog.create({ data: { reminderKey } });
      appointmentEmails++;
    }
  }
  return { appointmentEmails, readyEmails: 0 };
}
