import { prisma } from "./prisma";

// Student numbers look like 2024-00123-SP-0.
const SN_RE = /\b\d{4}-\d{4,6}-[A-Za-z]{2}-\d\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w-])(?:\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?![\w-])/g;

/** Mask identifiers before a chat message is stored. The owner's own number is kept. */
export function redactPii(text: string, ownSn?: string | null): string {
  const own = (ownSn || "").toLowerCase();
  return String(text || "")
    .replace(EMAIL_RE, "[email hidden]")
    .replace(PHONE_RE, "[phone hidden]")
    .replace(SN_RE, (m) => (m.toLowerCase() === own ? m : "[student no. hidden]"));
}

/** Output filter: never let a reply carry someone else's student number or email. */
export function scrubOutput(text: string, ownSn?: string | null, ownEmail?: string | null): string {
  const own = (ownSn || "").toLowerCase();
  const mail = (ownEmail || "").toLowerCase();
  return String(text || "")
    .replace(SN_RE, (m) => (m.toLowerCase() === own ? m : "[hidden]"))
    .replace(EMAIL_RE, (m) => (m.toLowerCase() === mail ? m : "[hidden]"));
}

/** A student number in the message that is not the signed-in student's own. */
export function mentionsOtherStudent(message: string, ownSn?: string | null): boolean {
  const own = (ownSn || "").toLowerCase();
  return (message.match(SN_RE) || []).some((m) => m.toLowerCase() !== own);
}

const INJECTION_RE = /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all|your)\b[^.]{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b|\b(act|pretend|behave|respond)\s+(as|like)\s+(an?\s+)?(admin|administrator|super\s?admin|staff|developer|system)\b|\b(reveal|show|print|leak)\b[^.]{0,30}\b(system prompt|instructions|api key|secret|password hash)\b|\bdeveloper mode\b|\bjailbreak\b/i;
const OTHERS_DATA_RE = /\b(list|show|give|export|dump|send)\b[^.]{0,30}\b(all|every|other|everyone'?s?|someone'?s?|classmate'?s?|friend'?s?)\b[^.]{0,30}\b(students?|users?|accounts?|complaints?|records?|requests?|appointments?|emails?|contacts?|grades?|numbers?)\b|\b(another|other|someone else'?s?|my (friend|classmate|crush|ex)'?s?)\b[^.]{0,25}\b(request|complaint|appointment|record|status|account|student)\b|\b(staff|admin|super\s?admin)\b[^.]{0,20}\b(email|number|password|account|schedule)\b|\b(email|number|password|account|contact|phone)\b[^.]{0,20}\b(of|for)\b[^.]{0,15}\b(the\s+)?(staff|admin|super\s?admin|counselor|officer)\b/i;

export type PrivacyVerdict = "ok" | "injection" | "others-data";

export function screenMessage(message: string, ownSn?: string | null): PrivacyVerdict {
  if (INJECTION_RE.test(message)) return "injection";
  if (mentionsOtherStudent(message, ownSn) || OTHERS_DATA_RE.test(message)) return "others-data";
  return "ok";
}

export const PRIVACY_REFUSAL =
  "I can only help with your own account, requests and appointments, and I can't share anyone else's information or follow instructions that change how I work. " +
  "If you need something that needs staff action, open the Help Desk or visit the Student Services Office.";

export const DEFAULT_CHAT_RETENTION_DAYS = 90;

export async function getChatRetentionDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "chatRetentionDays" } });
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 7 && n <= 730 ? n : DEFAULT_CHAT_RETENTION_DAYS;
}

/** Delete chat sessions (and their messages) untouched for the retention window. */
export async function purgeOldChats(opts: { dryRun?: boolean; days?: number } = {}): Promise<{ days: number; sessions: number }> {
  const days = opts.days ?? (await getChatRetentionDays());
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const old = await prisma.chatSession.findMany({ where: { updatedAt: { lt: cutoff } }, select: { id: true } });
  const ids = old.map((s) => s.id);
  if (!opts.dryRun && ids.length) {
    await prisma.chatFeedback.deleteMany({ where: { sessionId: { in: ids } } }).catch(() => {});
    await prisma.chatMessage.deleteMany({ where: { sessionId: { in: ids } } });
    await prisma.chatSession.deleteMany({ where: { id: { in: ids } } });
  }
  return { days, sessions: ids.length };
}
