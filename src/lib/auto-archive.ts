import { prisma } from "./prisma";
import { runArchive } from "./archive";
import { purgeOldChats } from "./assistant-privacy";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = "archiveLastRun";

/** Run the archive once if it has not run in the last ~23 hours (safe across restarts and multiple instances). */
export async function runArchiveIfDue(): Promise<void> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: LAST_RUN_KEY } });
    const last = row ? Date.parse(row.value) : 0;
    if (Number.isFinite(last) && Date.now() - last < DAY_MS - 60 * 60 * 1000) return;
    // Claim the slot first so concurrent instances do not both run.
    await prisma.systemSetting.upsert({
      where: { key: LAST_RUN_KEY },
      update: { value: new Date().toISOString() },
      create: { key: LAST_RUN_KEY, value: new Date().toISOString() },
    });
    await runArchive();
    await purgeOldChats();
  } catch (e) {
    console.error("[auto-archive] failed:", e);
  }
}

let started = false;
/** Check shortly after boot, then every hour; the due-check keeps it to one real run per day. */
export function startAutoArchive(): void {
  if (started) return;
  started = true;
  setTimeout(() => void runArchiveIfDue(), 45_000).unref?.();
  setInterval(() => void runArchiveIfDue(), 60 * 60 * 1000).unref?.();
}
