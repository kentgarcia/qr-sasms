import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError, ok } from "@/lib/http";

// Improvement spec F-2: per-answer 👍/👎 with toggle semantics.
// Body { chatMessageId, value: 1 | -1 }. Re-tapping the same value removes
// the vote. Own-session only — foreign ids 404 like a missing session, so
// no existence signal leaks across students.
export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const chatMessageId = String(body?.chatMessageId || "");
  const value = Number(body?.value);
  if (!chatMessageId) return jsonError(400, "chatMessageId is required.", "MISSING_FIELDS");
  if (value !== 1 && value !== -1) return jsonError(400, "value must be 1 or -1.", "INVALID_VALUE");

  const msg = await prisma.chatMessage.findFirst({
    where: { id: chatMessageId, role: "assistant" },
    select: { id: true, sessionId: true, session: { select: { studentId: true } } },
  });
  if (!msg || msg.session.studentId !== (auth.studentId || "")) {
    return jsonError(404, "Chat message not found.", "SESSION_NOT_FOUND");
  }

  const existing = await prisma.chatFeedback.findUnique({ where: { messageId: msg.id } });
  if (existing && existing.value === value) {
    await prisma.chatFeedback.delete({ where: { messageId: msg.id } });
    return ok({ ok: true, value: null as number | null });
  }
  await prisma.chatFeedback.upsert({
    where: { messageId: msg.id },
    update: { value },
    create: { messageId: msg.id, sessionId: msg.sessionId, studentId: auth.studentId || "", value },
  });
  return ok({ ok: true, value });
}
