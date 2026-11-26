export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutoArchive } = await import("./lib/auto-archive");
    startAutoArchive();
  }
}
