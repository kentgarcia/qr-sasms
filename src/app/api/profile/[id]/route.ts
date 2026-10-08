import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit, addNotification } from "@/lib/notify";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const status = String((await req.json().catch(() => ({})))?.status || "");
  if (!["Approved", "Rejected"].includes(status)) return jsonError(400, "Invalid decision.", "INVALID_STATUS");
  const change = await prisma.profileChange.findUnique({ where: { id: decodeURIComponent(params.id) } });
  if (!change || change.status !== "Pending") return jsonError(404, "Profile update not found.", "NOT_FOUND");
  if (status === "Approved") {
    const emailOwner = await prisma.user.findUnique({ where: { email: change.email } });
    if (emailOwner && emailOwner.id !== change.userId) return jsonError(409, "That email belongs to another account.", "EMAIL_TAKEN");
    await prisma.user.update({ where: { id: change.userId }, data: { name: change.name, email: change.email, course: change.course, year: change.year } });
  }
  const updated = await prisma.profileChange.update({ where: { id: change.id }, data: { status } });
  await addNotification(change.studentId, `Profile Update ${status}`, status === "Approved" ? "Your profile changes were verified and applied." : "Your profile update was not approved. Please contact the SSO if you need assistance.");
  await addAudit("INFO", `Profile update ${change.id} ${status.toLowerCase()} by ${auth.name}.`);
  return NextResponse.json(updated);
}
