import nodemailer, { Transporter } from "nodemailer";

let transporter: Transporter | null | undefined;

export function isEmailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter(): Transporter | null {
  if (!isEmailConfigured()) return null;
  if (transporter !== undefined) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    
    
    
    family: 4,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  } as any);
  return transporter;
}

export type SendMailResult =
  | { ok: true; mode: "SENT" }
  | { ok: false; mode: "FAILED"; error: string }
  | { ok: false; mode: "NO_EMAIL"; error: string };


export async function sendMail(opts: {
  to: string | null | undefined;
  subject: string;
  text: string;
}): Promise<SendMailResult | { ok: true; mode: "SIMULATED" }> {
  if (!opts.to) {
    return { ok: false, mode: "NO_EMAIL", error: "No email address on file." };
  }
  const t = getTransporter();
  if (!t) {
    
    return { ok: true, mode: "SIMULATED" };
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || "STARS <no-reply@pup-sanpedro.edu.ph>",
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    return { ok: true, mode: "SENT" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "send error";
    return { ok: false, mode: "FAILED", error: message };
  }
}
