import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, jsonError } from "@/lib/http";
import { addAudit } from "@/lib/notify";

const DEFAULT_SETTINGS = {
  businessHours: ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"],
  appointmentCapacity: 1,
  cancellationCutoffHours: 24,
  maxReschedules: 2,
  holidays: [],
  courses: ["BSCS", "BSIT", "BSBA", "BSA", "BEED"],
  emailTemplate: "{{message}}\n\n— STARS, PUP San Pedro Student Services Office",
  // Phase 3 (AI assistant spec): chatbot confidence thresholds. The keyword
  // high score and the semantic high/medium cosine similarities.
  assistantHighScore: 6,
  assistantHighSimilarity: 0.6,
  assistantMediumSimilarity: 0.45,
};

function readSettings(rows: { key: string; value: string }[]) {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const num = (key: string, fallback: number) => {
    const n = values[key] == null ? NaN : Number(values[key]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    businessHours: values.businessHours ? JSON.parse(values.businessHours) : DEFAULT_SETTINGS.businessHours,
    appointmentCapacity: values.appointmentCapacity ? Number(values.appointmentCapacity) : DEFAULT_SETTINGS.appointmentCapacity,
    cancellationCutoffHours: values.cancellationCutoffHours ? Number(values.cancellationCutoffHours) : DEFAULT_SETTINGS.cancellationCutoffHours,
    maxReschedules: values.maxReschedules != null ? Number(values.maxReschedules) : DEFAULT_SETTINGS.maxReschedules,
    holidays: values.holidays ? JSON.parse(values.holidays) : DEFAULT_SETTINGS.holidays,
    courses: values.courses ? JSON.parse(values.courses) : DEFAULT_SETTINGS.courses,
    emailTemplate: values.emailTemplate || DEFAULT_SETTINGS.emailTemplate,
    assistantHighScore: num("assistant.highScore", DEFAULT_SETTINGS.assistantHighScore),
    assistantHighSimilarity: num("assistant.highSimilarity", DEFAULT_SETTINGS.assistantHighSimilarity),
    assistantMediumSimilarity: num("assistant.mediumSimilarity", DEFAULT_SETTINGS.assistantMediumSimilarity),
  };
}

async function readServiceConfigs() {
  const { getServiceConfigs } = await import("@/lib/appointments");
  return getServiceConfigs();
}

export async function GET(req: NextRequest) {
  
  if (req.nextUrl.searchParams.get("public") === "registration") {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "courses" } });
    let courses = DEFAULT_SETTINGS.courses;
    try {
      if (setting?.value) {
        const saved = JSON.parse(setting.value);
        if (Array.isArray(saved) && saved.length) courses = saved;
      }
    } catch {
      
    }
    return NextResponse.json({ courses });
  }
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.systemSetting.findMany();
  return NextResponse.json({ ...readSettings(rows), serviceConfigs: await readServiceConfigs() });
}

export async function PUT(req: NextRequest) {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  const capacity = Number(body?.appointmentCapacity);
  const cutoff = Number(body?.cancellationCutoffHours);
  const maxReschedules = body?.maxReschedules == null ? DEFAULT_SETTINGS.maxReschedules : Number(body.maxReschedules);
  const hours = Array.isArray(body?.businessHours) ? body.businessHours.map((x: unknown) => String(x).trim()).filter(Boolean) : null;
  const holidays = Array.isArray(body?.holidays) ? body.holidays.map((x: unknown) => String(x).trim()).filter(Boolean) : null;
  const courses: string[] | null = Array.isArray(body?.courses)
    ? [...new Set<string>(body.courses.map((x: unknown) => String(x).trim()).filter(Boolean))]
    : null;
  const emailTemplate = String(body?.emailTemplate || "").trim();
  if (!hours?.length || hours.length > 20 || !courses?.length || courses.length > 30 || courses.some((course) => course.length > 40) || !Number.isInteger(capacity) || capacity < 1 || capacity > 50 || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > 168 || !Number.isInteger(maxReschedules) || maxReschedules < 0 || maxReschedules > 10 || !holidays || !emailTemplate || emailTemplate.length > 5000) {
    return jsonError(400, "Invalid system settings.", "INVALID_SETTINGS");
  }
  const serviceConfigs = Array.isArray(body?.serviceConfigs) ? body.serviceConfigs : null;
  // Phase 3: assistant thresholds are optional — absent keys leave stored values alone.
  const assistantHighScore = body?.assistantHighScore == null ? null : Number(body.assistantHighScore);
  const assistantHighSimilarity = body?.assistantHighSimilarity == null ? null : Number(body.assistantHighSimilarity);
  const assistantMediumSimilarity = body?.assistantMediumSimilarity == null ? null : Number(body.assistantMediumSimilarity);
  const assistantValid =
    (assistantHighScore == null || (Number.isInteger(assistantHighScore) && assistantHighScore >= 1 && assistantHighScore <= 100)) &&
    (assistantHighSimilarity == null || (assistantHighSimilarity > 0 && assistantHighSimilarity <= 1)) &&
    (assistantMediumSimilarity == null || (assistantMediumSimilarity > 0 && assistantMediumSimilarity <= 1)) &&
    (assistantHighSimilarity == null || assistantMediumSimilarity == null || assistantHighSimilarity > assistantMediumSimilarity);
  if (!assistantValid) {
    return jsonError(400, "Invalid assistant thresholds.", "INVALID_SETTINGS");
  }
  if (serviceConfigs) {
    const { APPOINTMENT_SERVICES } = await import("@/lib/appointments");
    for (const c of serviceConfigs) {
      const svc = String(c?.service || "").toUpperCase();
      const weekdays = Array.isArray(c?.weekdays) ? c.weekdays.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6) : null;
      if (!APPOINTMENT_SERVICES[svc] || !Number.isInteger(c?.capacity) || c.capacity < 1 || c.capacity > 50 || !Number.isInteger(c?.durationMin) || c.durationMin < 5 || c.durationMin > 240 || !weekdays?.length) {
        return jsonError(400, `Invalid service configuration for ${svc || "unknown service"}.`, "INVALID_SETTINGS");
      }
    }
  }
  await prisma.$transaction([
    prisma.systemSetting.upsert({ where: { key: "businessHours" }, update: { value: JSON.stringify(hours) }, create: { key: "businessHours", value: JSON.stringify(hours) } }),
    prisma.systemSetting.upsert({ where: { key: "appointmentCapacity" }, update: { value: String(capacity) }, create: { key: "appointmentCapacity", value: String(capacity) } }),
    prisma.systemSetting.upsert({ where: { key: "cancellationCutoffHours" }, update: { value: String(cutoff) }, create: { key: "cancellationCutoffHours", value: String(cutoff) } }),
    prisma.systemSetting.upsert({ where: { key: "maxReschedules" }, update: { value: String(maxReschedules) }, create: { key: "maxReschedules", value: String(maxReschedules) } }),
    prisma.systemSetting.upsert({ where: { key: "holidays" }, update: { value: JSON.stringify(holidays) }, create: { key: "holidays", value: JSON.stringify(holidays) } }),
    prisma.systemSetting.upsert({ where: { key: "courses" }, update: { value: JSON.stringify(courses) }, create: { key: "courses", value: JSON.stringify(courses) } }),
    prisma.systemSetting.upsert({ where: { key: "emailTemplate" }, update: { value: emailTemplate }, create: { key: "emailTemplate", value: emailTemplate } }),
    ...(assistantHighScore == null ? [] : [prisma.systemSetting.upsert({ where: { key: "assistant.highScore" }, update: { value: String(assistantHighScore) }, create: { key: "assistant.highScore", value: String(assistantHighScore) } })]),
    ...(assistantHighSimilarity == null ? [] : [prisma.systemSetting.upsert({ where: { key: "assistant.highSimilarity" }, update: { value: String(assistantHighSimilarity) }, create: { key: "assistant.highSimilarity", value: String(assistantHighSimilarity) } })]),
    ...(assistantMediumSimilarity == null ? [] : [prisma.systemSetting.upsert({ where: { key: "assistant.mediumSimilarity" }, update: { value: String(assistantMediumSimilarity) }, create: { key: "assistant.mediumSimilarity", value: String(assistantMediumSimilarity) } })]),
    ...(serviceConfigs || []).map((c: { service: string; capacity: number; durationMin: number; weekdays: number[] }) =>
      prisma.serviceSlotConfig.upsert({
        where: { service: String(c.service).toUpperCase() },
        update: { capacity: c.capacity, durationMin: c.durationMin, weekdays: c.weekdays.map(Number), active: true },
        create: { service: String(c.service).toUpperCase(), capacity: c.capacity, durationMin: c.durationMin, weekdays: c.weekdays.map(Number), active: true },
      })
    ),
  ]);
  await addAudit("INFO", `System settings updated by ${auth.name}.`);
  return NextResponse.json({ ok: true });
}
