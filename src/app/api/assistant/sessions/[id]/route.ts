import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError, ok } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student", "admin"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  // Staff can open any session (they already see all tickets, including
  // chat-linked ones); students only their own. Powers the chatbot-origin
  // quote in the admin ticket modal (UX spec C-5).
  const isStaff = auth.role === "admin" || auth.role === "super_admin";
  const session = await prisma.chatSession.findFirst({
    where: isStaff ? { id } : { id, studentId: auth.studentId || "" },
    include: { messages: { orderBy: { createdAt: "asc" }, include: { feedback: true } } },
  });
  if (!session) return jsonError(404, "Chat session not found.", "SESSION_NOT_FOUND");
  return NextResponse.json(session);
}

// Improvement spec F-7: rename own chat (subject is a mutable column).
// Staff rename is admin-only surfaces territory — students own-only here.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const id = decodeURIComponent(params.id);
  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!subject) return jsonError(400, "subject is required.", "MISSING_FIELDS");

  const session = await prisma.chatSession.findFirst({
    where: { id, studentId: auth.studentId || "" },
    select: { id: true },
  });
  if (!session) return jsonError(404, "Chat session not found.", "SESSION_NOT_FOUND");
  await prisma.chatSession.update({ where: { id }, data: { subject } });
  return ok({ ok: true, id, subject });
}
