import QRCode from "qrcode";
import { prisma } from "./prisma";
import { sendMail, type MailAttachment } from "./mailer";
import { normSN } from "./format";
import { buildAppointmentQrPayload } from "./signature";
import { buildAppointmentIcs } from "./calendar";

function escHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function emailForStudent(studentId: string): Promise<string | null> {
  const sn = normSN(studentId);
  const user = await prisma.user.findFirst({ where: { studentId: sn } });
  if (user?.email) return user.email;
  const entry = await prisma.masterlistEntry.findFirst({ where: { sn } });
  if (entry?.email) return entry.email;
  return null;
}

export type EmailQrAppointment = {
  code: string;
  studentId: string;
  dateISO: string;
  dateLabel: string;
  time: string;
  serviceLabel?: string;
};

export async function notifyStudentByEmail(opts: {
  studentId: string;
  name: string;
  title: string;
  message: string;
  ref: string;
  qrAppointment?: EmailQrAppointment | null;
}) {
  const to = await emailForStudent(opts.studentId);
  const template = await prisma.systemSetting.findUnique({ where: { key: "emailTemplate" } });
  const text = (template?.value || "{{message}}\n\n— STARS")
    .replaceAll("{{message}}", opts.message)
    .replaceAll("{{name}}", opts.name)
    .replaceAll("{{title}}", opts.title);

  let html: string | undefined;
  let attachments: MailAttachment[] | undefined;

  if (opts.qrAppointment) {
    try {
      const qa = opts.qrAppointment;
      const payload = buildAppointmentQrPayload(qa.code, qa.studentId, qa.dateISO);
      const pngBuffer = await QRCode.toBuffer(payload, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#1a0505", light: "#ffffff" },
      });
      const icsContent = buildAppointmentIcs({
        code: qa.code,
        serviceLabel: qa.serviceLabel,
        dateLabel: qa.dateLabel,
        time: qa.time,
        studentName: opts.name,
        studentId: qa.studentId,
      });
      attachments = [
        {
          filename: `STARS-${qa.code}-QR.png`,
          content: pngBuffer,
          cid: "appointment-qr",
          contentType: "image/png",
        },
        {
          filename: `STARS-${qa.code}.ics`,
          content: Buffer.from(icsContent, "utf-8"),
          contentType: "text/calendar; charset=utf-8; method=PUBLISH",
        },
      ];
      html = `
        <div style="font-family:Inter,Arial,sans-serif;color:#1a0505;max-width:520px;margin:0 auto;line-height:1.55;">
          <p style="white-space:pre-line;">${escHtml(text)}</p>
          <div style="margin-top:18px;padding:18px;border:1px solid #d9b8b8;border-radius:14px;background:#fffaf4;text-align:center;">
            <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8B1A1A;margin-bottom:8px;">Offline Appointment QR Pass</div>
            <img src="cid:appointment-qr" width="200" height="200" alt="QR Pass for ${escHtml(qa.code)}" style="display:block;margin:0 auto;border-radius:8px;background:#fff;padding:6px;border:1px solid #eee;" />
            <div style="font-size:22px;font-weight:900;letter-spacing:.05em;margin-top:10px;color:#1a0505;">${escHtml(qa.code)}</div>
            <div style="font-size:12px;color:#555;margin-top:4px;">${qa.serviceLabel ? `${escHtml(qa.serviceLabel)} · ` : ""}${escHtml(qa.dateLabel)} at ${escHtml(qa.time)}</div>
            <div style="font-size:11px;color:#777;margin-top:8px;">Save this image or show it from your email at the SSO Service Desk — works even when the portal link cannot be accessed.</div>
          </div>
        </div>`;
    } catch {
      // Fallback to plain-text email if QR generation fails.
    }
  }

  const result = await sendMail({ to, subject: opts.title, text, html, attachments });
  const log = await prisma.emailLog.create({
    data: {
      to: to || null,
      name: opts.name,
      ref: opts.ref,
      doc: opts.title,
      status: result.ok ? "Success" : "Failed",
      mode: result.mode,
      error: "error" in result ? result.error : null,
    },
  });
  return log;
}


export async function addNotification(target: string, title: string, body: string) {
  return prisma.notification.create({ data: { target, title, body } });
}

export async function addAudit(type: "INFO" | "WARN" | "ERROR", msg: string) {
  return prisma.auditLog.create({ data: { type, msg } });
}
