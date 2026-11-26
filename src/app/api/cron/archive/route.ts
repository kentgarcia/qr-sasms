import { NextRequest, NextResponse } from "next/server";
import { runArchive } from "@/lib/archive";
import { purgeOldChats } from "@/lib/assistant-privacy";

// Schedule daily: POST /api/cron/archive with `Authorization: Bearer <CRON_SECRET>`.
// Add `?dryRun=1` to preview counts without changing anything.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const archive = await runArchive({ dryRun });
  const chats = await purgeOldChats({ dryRun });
  return NextResponse.json({ ...archive, chats });
}
