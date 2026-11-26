import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { archiveWhere } from "@/lib/archive";
import { addAudit, addNotification } from "@/lib/notify";
import { genId, fnow, withTs, withTsList } from "@/lib/format";

export async function GET(req: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;
  const where = { ...(auth.role === "admin" || auth.role === "super_admin" ? {} : { sn: auth.studentId || "" }), ...archiveWhere(req) };
  const rows = await prisma.ticket.findMany({ where, orderBy: { createdAt: "asc" } });
  const ids = rows.map((r) => r.id);
  const fbRows = ids.length
    ? await prisma.serviceFeedback.findMany({
        where: { requestId: { in: ids } },
        select: { id: true, requestId: true, rating: true, comment: true, createdAt: true },
      })
    : [];
  const fbById = new Map(
    fbRows.map((fb) => [
      fb.requestId,
      {
        id: fb.id,
        requestId: fb.requestId,
        rating: fb.rating,
        comment: fb.comment,
        ts: fnow(fb.createdAt),
      },
    ])
  );
  return NextResponse.json(
    withTsList(rows).map((t) => ({
      ...t,
      feedback: fbById.get(t.id) || null,
    }))
  );
}


export async function POST(req: NextRequest) {
  const auth = await requireSession(["student"]);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => ({}));
  const category = (body?.category || "").toString();
  const subject = (body?.subject || "").toString().trim();
  const message = (body?.message || "").toString().trim();
  if (!subject || !message) return jsonError(400, "Subject and message are required.", "MISSING_FIELDS");

  // Phase 0 (AI assistant spec): optional link to the chat session that
  // produced this ticket. The session must belong to the caller.
  const chatSessionIdRaw = (body?.chatSessionId || "").toString() || null;
  let chatSessionId: string | null = null;
  if (chatSessionIdRaw) {
    const chat = await prisma.chatSession.findFirst({
      where: { id: chatSessionIdRaw, studentId: auth.studentId || "" },
    });
    if (!chat) return jsonError(404, "Chat session not found.", "SESSION_NOT_FOUND");
    chatSessionId = chat.id;
  }

  const created = await prisma.ticket.create({
    data: {
      id: genId("TKT"),
      sn: auth.studentId || "",
      name: auth.name,
      category,
      subject,
      status: "Open",
      msgs: [{ from: "student", by: auth.name, text: message, ts: fnow() }],
      chatSessionId,
    },
  });

  await addAudit("INFO", `Help desk ticket opened by ${auth.name}: ${subject}`);
  await addNotification("admin", "New Help Desk Ticket", `${auth.name}: "${subject}" (${category}).`);

  return NextResponse.json(withTs(created), { status: 201 });
}
