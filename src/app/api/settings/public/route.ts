import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DEFAULT_SPLASH_URL = "/pup-san-pedro-campus.svg";
const DEFAULT_SPLASH_CAPTION = "PUP San Pedro Campus — Student Services Office";

export async function GET() {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ["loginSplashUrl", "loginSplashCaption"] } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return NextResponse.json({
      loginSplashUrl: (map.loginSplashUrl || "").trim() || DEFAULT_SPLASH_URL,
      loginSplashCaption: (map.loginSplashCaption || "").trim() || DEFAULT_SPLASH_CAPTION,
      defaultSplashUrl: DEFAULT_SPLASH_URL,
    });
  } catch {
    return NextResponse.json({
      loginSplashUrl: DEFAULT_SPLASH_URL,
      loginSplashCaption: DEFAULT_SPLASH_CAPTION,
      defaultSplashUrl: DEFAULT_SPLASH_URL,
    });
  }
}
