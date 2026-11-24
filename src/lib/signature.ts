import { createHmac, timingSafeEqual } from "crypto";


export function signDocument(reference: string, studentId: string, status: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for document signatures.");
  return createHmac("sha256", secret).update(`${reference}|${studentId}|${status}`).digest("hex");
}

function qrHmac8(code: string, studentId: string, dateISO: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for appointment QR signatures.");
  return createHmac("sha256", secret)
    .update(`STARS1|${code}|${studentId}|${dateISO}`)
    .digest("hex")
    .slice(0, 8);
}

/** Build an offline-verifiable, compact QR payload for an appointment. */
export function buildAppointmentQrPayload(code: string, studentId: string, dateISO: string): string {
  const sig = qrHmac8(code, studentId, dateISO);
  return `STARS1|${code}|${studentId}|${dateISO}|${sig}`;
}

export type ParsedAppointmentQr =
  | { kind: "signed"; code: string; studentId: string; dateISO: string; validSignature: boolean }
  | { kind: "code"; code: string }
  | { kind: "invalid" };

/** Parse either a signed STARS1 QR payload or a manual APT-### code. */
export function parseAppointmentQrPayload(raw: string): ParsedAppointmentQr {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { kind: "invalid" };
  if (trimmed.startsWith("STARS1|")) {
    const parts = trimmed.split("|");
    if (parts.length !== 5) return { kind: "invalid" };
    const [, code, studentId, dateISO, sig] = parts;
    if (!code || !studentId || !sig || sig.length !== 8) return { kind: "invalid" };
    const expected = qrHmac8(code, studentId, dateISO);
    let validSignature = false;
    try {
      validSignature = timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
    } catch {
      validSignature = false;
    }
    return { kind: "signed", code: code.toUpperCase(), studentId, dateISO, validSignature };
  }
  const codeMatch = /\b(APT-\d{3,})\b/i.exec(trimmed);
  if (codeMatch) {
    return { kind: "code", code: codeMatch[1].toUpperCase() };
  }
  return { kind: "invalid" };
}
