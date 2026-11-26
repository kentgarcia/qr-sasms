import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

/** Parse "September 26, 2026" + "8:00 AM" into a Date at Asia/Manila (+08:00). Mirrors src/lib/appointments.ts. */
function parseSlotStart(dateLabel: string, time: string): Date | null {
  const probe = new Date(`${dateLabel} 12:00:00`);
  if (Number.isNaN(probe.getTime())) return null;
  const normalized = probe.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  if (normalized !== dateLabel) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(time);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (hh < 1 || hh > 12 || mm > 59) return null;
  if (ap === "AM") hh = hh === 12 ? 0 : hh;
  else hh = hh === 12 ? 12 : hh + 12;
  const iso = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, "0")}-${String(
    probe.getDate()
  ).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateISOPHT(dateLabel: string): string {
  const probe = new Date(`${dateLabel} 12:00:00`);
  if (Number.isNaN(probe.getTime())) return "";
  return `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, "0")}-${String(
    probe.getDate()
  ).padStart(2, "0")}`;
}

/** Future weekday label `offset` days out, skipping weekends + excluded labels. */
function futureWeekdayLabel(offset: number, exclude: string[] = []): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (isWeekend(d) || exclude.includes(formatLabel(d))) {
    d.setDate(d.getDate() + 1);
  }
  return formatLabel(d);
}

/** Most recent past weekday label (for read-only history rows). */
function pastWeekdayLabel(offsetBack = 1): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetBack);
  while (isWeekend(d)) d.setDate(d.getDate() - 1);
  return formatLabel(d);
}


// ───────────────────────── demo-environment helpers ─────────────────────────
// Deterministic PRNG so every run produces the same "history" (idempotent reseeds).
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260901);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

/** Record ids look like the ones the app generates (PREFIX-<base36 time><2 digits>) but are stable across runs. */
const ID_EPOCH = Date.UTC(2026, 5, 1);
let idCounter = 0;
function rid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${(ID_EPOCH + idCounter * 4_736_000).toString(36).toUpperCase()}${String(10 + ((idCounter * 7) % 89))}`;
}

/** "Nov 27, 2026, 5:00 AM" — same shape the API stamps on history rows. */
function stamp(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }).format(d);
}
function minutesOfSlot(time: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time)!;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + parseInt(m[2], 10);
}
function manilaMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", hour12: false, timeZone: "Asia/Manila" }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")!.value, 10) % 24;
  return h * 60 + parseInt(parts.find((p) => p.type === "minute")!.value, 10);
}
/** A Date on `base`'s calendar day at the given clock time (server-local; good enough for stamps). */
function onDay(base: Date, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setHours(hour, minute, between(0, 59), 0);
  return d;
}
function dayShift(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Philippine holidays (upcoming) — used as the "closed dates" setting and kept clear of bookings. */
function upcomingHolidays(): Array<{ date: string; name: string }> {
  const y = new Date().getFullYear();
  const defs = [[y, 10, 30, "Bonifacio Day"], [y, 11, 8, "Feast of the Immaculate Conception"], [y, 11, 24, "Christmas Eve"], [y, 11, 25, "Christmas Day"], [y, 11, 30, "Rizal Day"], [y, 11, 31, "New Year's Eve"], [y + 1, 0, 1, "New Year's Day"]] as Array<[number, number, number, string]>;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return defs.map(([yy, mm, dd, name]) => ({ d: new Date(yy, mm, dd), name })).filter((h) => h.d >= today).map((h) => ({ date: formatLabel(h.d), name: h.name }));
}

// ───────────────────────── small document writers ─────────────────────────
function writeFileEnsured(rel: string, content: string | Buffer) {
  const file = path.join(process.cwd(), "public", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function miniPdf(title: string, lines: string[]): string {
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const content = ["BT /F1 18 Tf 60 740 Td (" + esc(title) + ") Tj ET", ...lines.map((l, i) => `BT /F1 11 Tf 60 ${700 - i * 20} Td (${esc(l)}) Tj ET`)].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}
function receiptSvg(orNo: string, name: string, amount: string, what: string, date: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300" font-family="Arial,Helvetica,sans-serif"><rect width="480" height="300" fill="#fffdf8" stroke="#bbb"/><text x="240" y="38" text-anchor="middle" font-size="15" font-weight="bold" fill="#7A0F1F">POLYTECHNIC UNIVERSITY OF THE PHILIPPINES</text><text x="240" y="58" text-anchor="middle" font-size="12">San Pedro Campus · Cashier's Office</text><text x="240" y="92" text-anchor="middle" font-size="17" font-weight="bold">OFFICIAL RECEIPT</text><text x="30" y="132" font-size="13">O.R. No.: ${orNo}</text><text x="450" y="132" text-anchor="end" font-size="13">Date: ${date}</text><text x="30" y="165" font-size="13">Received from: ${name}</text><text x="30" y="195" font-size="13">Payment for: ${what}</text><text x="30" y="235" font-size="15" font-weight="bold">Amount: PHP ${amount}</text><text x="450" y="275" text-anchor="end" font-size="11" fill="#666">Authorized cashier signature</text></svg>`;
}
function affidavitSvg(name: string, date: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340" viewBox="0 0 480 340" font-family="Georgia,serif"><rect width="480" height="340" fill="#fff" stroke="#bbb"/><text x="240" y="40" text-anchor="middle" font-size="18" font-weight="bold">AFFIDAVIT OF LOSS</text><text x="30" y="85" font-size="12.5">I, ${name}, of legal age, a bonafide student of the</text><text x="30" y="108" font-size="12.5">Polytechnic University of the Philippines – San Pedro,</text><text x="30" y="131" font-size="12.5">do hereby state that I lost my Student ID and have</text><text x="30" y="154" font-size="12.5">been unable to recover it despite diligent efforts.</text><text x="30" y="200" font-size="12.5">Executed on ${date}.</text><text x="450" y="300" text-anchor="end" font-size="11" fill="#555">Notarized · Doc. No. 214; Page 44; Book 9</text></svg>`;
}

type Stu = { sn: string; name: string; email: string; course: string; year: string; registered: boolean };
const SCHOOL_YEAR = "2026-2027";
const SLOTS = ["8:00 AM", "8:30 AM", "9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "1:00 PM", "1:30 PM", "2:00 PM", "2:30 PM"];

/** Remove everything a previous demo load created (or, with --reset, all operational data). */
async function clearData(reset: boolean) {
  if (reset) {
    console.log("  --reset: clearing operational data (staff accounts, FAQs and settings are kept)…");
    await prisma.chatFeedback.deleteMany(); await prisma.chatMessage.deleteMany(); await prisma.ticket.deleteMany(); await prisma.chatSession.deleteMany();
    for (const m of [prisma.serviceFeedback, prisma.reminderLog, prisma.profileChange, prisma.emailOtp, prisma.emailLog, prisma.notification, prisma.auditLog, prisma.memo,
      prisma.downloadableForm, prisma.bulletin, prisma.complaint, prisma.eventRequest, prisma.serviceRequest, prisma.idApplication, prisma.referral, prisma.queueEntry,
      prisma.slotBlock, prisma.organizationRepresentative, prisma.organization, prisma.masterlistEntry, prisma.masterlistGroup] as Array<{ deleteMany: () => Promise<unknown> }>) {
      await m.deleteMany();
    }
    await prisma.user.deleteMany({ where: { role: "STUDENT" } });
    return;
  }
  // Light cleanup of rows written by the very first seed script (they carried "SEED" in their ids/text).
  const has = { contains: "SEED" };
  await prisma.serviceFeedback.deleteMany({ where: { requestId: has } });
  await prisma.reminderLog.deleteMany({ where: { reminderKey: { startsWith: "seed:" } } });
  await prisma.profileChange.deleteMany({ where: { id: has } });
  await prisma.ticket.deleteMany({ where: { id: has } });
  await prisma.chatSession.deleteMany({ where: { id: has } });
  await prisma.complaint.deleteMany({ where: { id: has } });
  await prisma.eventRequest.deleteMany({ where: { id: has } });
  await prisma.referral.deleteMany({ where: { id: has } });
  await prisma.idApplication.deleteMany({ where: { id: has } });
  await prisma.serviceRequest.deleteMany({ where: { id: has } });
  await prisma.bulletin.deleteMany({ where: { id: has } });
  await prisma.downloadableForm.deleteMany({ where: { id: has } });
  await prisma.memo.deleteMany({ where: { id: has } });
  await prisma.slotBlock.deleteMany({ where: { reason: { startsWith: "Seed" } } });
  await prisma.emailLog.deleteMany({ where: { ref: has } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ msg: has }, { msg: { contains: "seeded" } }, { msg: { contains: "initialized" } }] } });
  await prisma.notification.deleteMany({ where: { body: { startsWith: "Seed" } } });
  await prisma.organizationRepresentative.deleteMany({ where: { organization: { name: { startsWith: "Seed" } } } }).catch(() => undefined);
  await prisma.organization.deleteMany({ where: { name: { startsWith: "Seed" } } }).catch(() => undefined);
}

async function main() {
  const RESET = process.argv.includes("--reset") || process.env.SEED_RESET === "1";
  console.log("Preparing STARS demo data…");
  await clearData(RESET);

  const studentPass = await bcrypt.hash("student123", 10);
  const adminPass = await bcrypt.hash("Admin@2026!", 10);
  const superAdminPass = await bcrypt.hash("SuperAdmin@2026!", 10);
  const scannerPass = await bcrypt.hash("scan2026", 10);

  // ── Staff accounts ──
  await prisma.user.upsert({
    where: { email: "superadmin@pup.edu.ph" },
    update: { role: "SUPER_ADMIN", name: "SSO Super Admin", approved: true, active: true },
    create: { email: "superadmin@pup.edu.ph", passwordHash: superAdminPass, role: "SUPER_ADMIN", name: "SSO Super Admin", approved: true, createdAt: daysAgo(150) },
  });
  await prisma.user.upsert({
    where: { email: "admin@pup.edu.ph" },
    update: { role: "ADMIN", name: "SSO Admin", approved: true, active: true },
    create: { email: "admin@pup.edu.ph", passwordHash: adminPass, role: "ADMIN", name: "SSO Admin", approved: true, createdAt: daysAgo(150) },
  });
  await prisma.user.upsert({
    where: { email: "scanner@pup.edu.ph" },
    update: {},
    create: { email: "scanner@pup.edu.ph", passwordHash: scannerPass, role: "SCANNER", name: "Scanner Desk", approved: true, createdAt: daysAgo(150) },
  });

  // ── Students: masterlist (the school's roster) + registered accounts (subset) ──
  const students: Stu[] = [
    { sn: "2024-00123-SP-0", name: "Juan dela Cruz", email: "student@pup.edu.ph", course: "BSCS", year: "3rd Year", registered: true },
    { sn: "2024-00091-SP-0", name: "Maria Santos", email: "maria.santos@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "2nd Year", registered: true },
    { sn: "2024-00102-SP-0", name: "Pedro Reyes", email: "pedro.reyes@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "2nd Year", registered: true },
    { sn: "2024-00115-SP-0", name: "Ana Flores", email: "ana.flores@iskolarngbayan.pup.edu.ph", course: "BSA", year: "1st Year", registered: true },
    { sn: "2024-00134-SP-0", name: "Liza Manguba", email: "liza.manguba@iskolarngbayan.pup.edu.ph", course: "BEED", year: "4th Year", registered: true },
    { sn: "2024-00145-SP-0", name: "Rico Aguinaldo", email: "rico.aguinaldo@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", registered: true },
    { sn: "2024-00150-SP-0", name: "Jose Mercado", email: "jose.mercado@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "3rd Year", registered: false },
    { sn: "2024-00151-SP-0", name: "Rosa Aquino", email: "rosa.aquino@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "3rd Year", registered: false },
    { sn: "2024-00200-SP-0", name: "Carla Dizon", email: "carla.dizon@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", registered: true },
    // 1st year (batch 2026)
    { sn: "2026-00012-SP-0", name: "Angelica Bautista", email: "angelica.bautista@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", registered: true },
    { sn: "2026-00027-SP-0", name: "Mark Anthony Ramos", email: "mark.ramos@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "1st Year", registered: true },
    { sn: "2026-00033-SP-0", name: "Jasmine Villanueva", email: "jasmine.villanueva@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "1st Year", registered: true },
    { sn: "2026-00048-SP-0", name: "Kyle Navarro", email: "kyle.navarro@iskolarngbayan.pup.edu.ph", course: "BSA", year: "1st Year", registered: false },
    { sn: "2026-00054-SP-0", name: "Bea Castillo", email: "bea.castillo@iskolarngbayan.pup.edu.ph", course: "BEED", year: "1st Year", registered: true },
    { sn: "2026-00071-SP-0", name: "Paolo Mendoza", email: "paolo.mendoza@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "1st Year", registered: true },
    // 2nd year (batch 2025)
    { sn: "2025-00019-SP-0", name: "Trisha Gonzales", email: "trisha.gonzales@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "2nd Year", registered: true },
    { sn: "2025-00036-SP-0", name: "Nathaniel Soriano", email: "nathaniel.soriano@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "2nd Year", registered: true },
    { sn: "2025-00042-SP-0", name: "Francine Domingo", email: "francine.domingo@iskolarngbayan.pup.edu.ph", course: "BSA", year: "2nd Year", registered: true },
    { sn: "2025-00058-SP-0", name: "Carlo Pascual", email: "carlo.pascual@iskolarngbayan.pup.edu.ph", course: "BEED", year: "2nd Year", registered: true },
    { sn: "2025-00063-SP-0", name: "Hazel Ocampo", email: "hazel.ocampo@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "2nd Year", registered: false },
    // 3rd year (batch 2024)
    { sn: "2024-00167-SP-0", name: "Miguel Tolentino", email: "miguel.tolentino@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "3rd Year", registered: true },
    { sn: "2024-00172-SP-0", name: "Denise Cabrera", email: "denise.cabrera@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "3rd Year", registered: true },
    { sn: "2024-00188-SP-0", name: "Joshua Lim", email: "joshua.lim@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "3rd Year", registered: true },
    { sn: "2024-00193-SP-0", name: "Kristine Salazar", email: "kristine.salazar@iskolarngbayan.pup.edu.ph", course: "BSA", year: "3rd Year", registered: true },
    { sn: "2024-00207-SP-0", name: "Ronnie Alcantara", email: "ronnie.alcantara@iskolarngbayan.pup.edu.ph", course: "BEED", year: "3rd Year", registered: true },
    // 4th year (batch 2023)
    { sn: "2023-00014-SP-0", name: "Camille Agustin", email: "camille.agustin@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "4th Year", registered: true },
    { sn: "2023-00029-SP-0", name: "Gabriel Santiago", email: "gabriel.santiago@iskolarngbayan.pup.edu.ph", course: "BSIT", year: "4th Year", registered: true },
    { sn: "2023-00041-SP-0", name: "Patricia Evangelista", email: "patricia.evangelista@iskolarngbayan.pup.edu.ph", course: "BSBA", year: "4th Year", registered: true },
    { sn: "2023-00056-SP-0", name: "Leandro Cruz", email: "leandro.cruz@iskolarngbayan.pup.edu.ph", course: "BEED", year: "4th Year", registered: false },
    { sn: "2023-00062-SP-0", name: "Shaira Magno", email: "shaira.magno@iskolarngbayan.pup.edu.ph", course: "BSA", year: "4th Year", registered: false },
  ];
  for (const s of students) {
    const m = { sn: s.sn, name: s.name, email: s.email, course: s.course, year: s.year, schoolYear: SCHOOL_YEAR };
    await prisma.masterlistEntry.upsert({ where: { sn: s.sn }, update: m, create: m });
  }
  for (const g of [
    { schoolYear: SCHOOL_YEAR, course: "BSCS", year: "3rd Year" }, { schoolYear: SCHOOL_YEAR, course: "BSIT", year: "2nd Year" },
    { schoolYear: SCHOOL_YEAR, course: "BSBA", year: "1st Year" }, { schoolYear: SCHOOL_YEAR, course: "BEED", year: "4th Year" },
  ]) {
    await prisma.masterlistGroup.upsert({ where: { schoolYear_course_year: g }, update: {}, create: { ...g, ownerId: null } });
  }
  const accounts = new Map<string, { id: string }>();
  for (const [i, s] of students.entries()) {
    if (!s.registered) continue;
    const existingBySn = await prisma.user.findUnique({ where: { studentId: s.sn } });
    if (existingBySn) { await prisma.user.update({ where: { id: existingBySn.id }, data: { approved: true, active: true } }); accounts.set(s.sn, existingBySn); continue; }
    const u = await prisma.user.upsert({
      where: { email: s.email },
      update: {},
      create: { studentId: s.sn, email: s.email, passwordHash: studentPass, role: "STUDENT", name: s.name, course: s.course, year: s.year, approved: true, createdAt: daysAgo(40 + ((i * 11) % 80)) },
    });
    accounts.set(s.sn, u);
  }
  // Newly signed-up students whose numbers are not on the roster yet (awaiting SSO verification).
  for (const [i, u] of [
    { sn: "2026-00188-SP-0", name: "Mikaela Ramos", email: "mikaela.ramos@gmail.com", course: "BSIT", year: "1st Year" },
    { sn: "2025-00421-SP-0", name: "Joshua Lim", email: "joshua.lim@gmail.com", course: "BSBA", year: "2nd Year" },
  ].entries()) {
    const exists = await prisma.user.findFirst({ where: { OR: [{ studentId: u.sn }, { email: u.email }] } });
    if (!exists) await prisma.user.create({ data: { studentId: u.sn, email: u.email, passwordHash: studentPass, role: "STUDENT", name: u.name, course: u.course, year: u.year, approved: true, verified: false, createdAt: daysAgo(1 + i) } });
  }
  const reg = students.filter((s) => s.registered);
  const byName = (n: string) => students.find((s) => s.name === n)!;
  const juan = byName("Juan dela Cruz"), pedro = byName("Pedro Reyes"), maria = byName("Maria Santos");

  // ── System settings ──
  const holidays = upcomingHolidays();
  const holidayLabels = new Set(holidays.map((h) => h.date));
  const settings: Array<{ key: string; value: string }> = [
    { key: "businessHours", value: JSON.stringify(SLOTS) },
    { key: "appointmentCapacity", value: "1" },
    { key: "cancellationCutoffHours", value: "24" },
    { key: "maxReschedules", value: "2" },
    { key: "courses", value: JSON.stringify(["BSCS", "BSIT", "BSBA", "BSA", "BEED"]) },
    { key: "emailTemplate", value: "{{message}}\n\n— STARS, PUP San Pedro Student Services Office" },
    { key: "assistant.highScore", value: "6" },
    { key: "assistant.highSimilarity", value: "0.6" },
    { key: "assistant.mediumSimilarity", value: "0.45" },
  ];
  for (const s of settings) await prisma.systemSetting.upsert({ where: { key: s.key }, update: {}, create: s });
  await prisma.systemSetting.upsert({ where: { key: "holidays" }, update: { value: JSON.stringify(holidays) }, create: { key: "holidays", value: JSON.stringify(holidays) } });

  for (const c of [
    { service: "GENERAL", durationMin: 10, capacity: 1 }, { service: "ID_NEW", durationMin: 10, capacity: 4 }, { service: "ID_LOST", durationMin: 15, capacity: 3 },
    { service: "EVENT", durationMin: 30, capacity: 2 }, { service: "AUTH", durationMin: 10, capacity: 4 }, { service: "EXCUSE", durationMin: 10, capacity: 4 }, { service: "PSYCH", durationMin: 45, capacity: 1 },
  ]) {
    await prisma.serviceSlotConfig.upsert({
      where: { service: c.service },
      update: { durationMin: c.durationMin, capacity: c.capacity, weekdays: [1, 2, 3, 4, 5], active: true },
      create: { ...c, weekdays: [1, 2, 3, 4, 5], active: true },
    });
  }

  // ── Student organizations + representatives ──
  const orgCs = await prisma.organization.upsert({ where: { name: "PUP San Pedro Computer Society" }, update: {}, create: { name: "PUP San Pedro Computer Society", adviserName: "Prof. Marlon Villanueva", schoolYear: SCHOOL_YEAR, active: true } });
  const orgJe = await prisma.organization.upsert({ where: { name: "Junior Entrepreneurs' Guild" }, update: {}, create: { name: "Junior Entrepreneurs' Guild", adviserName: "Prof. Teresita Alonzo", schoolYear: SCHOOL_YEAR, active: true } });
  const orgAc = await prisma.organization.upsert({ where: { name: "Alliance of Future Educators" }, update: {}, create: { name: "Alliance of Future Educators", adviserName: "Prof. Rodel Manalastas", schoolYear: SCHOOL_YEAR, active: true } });
  for (const [org, sn] of [[orgCs, pedro.sn], [orgJe, maria.sn], [orgAc, byName("Liza Manguba").sn]] as const) {
    const has = await prisma.organizationRepresentative.findFirst({ where: { organizationId: org.id, studentId: sn } });
    if (!has) await prisma.organizationRepresentative.create({ data: { organizationId: org.id, studentId: sn, assignedBy: "SSO Super Admin", active: true, expiresAt: null } });
  }

  // ───────────────────────── appointments: a month of history + today + the coming week ─────────────────────────
  const today = new Date();
  const isWork = (d: Date) => !isWeekend(d) && !holidayLabels.has(formatLabel(d));
  const pastDays: Date[] = [];
  for (let k = 1; pastDays.length < 24 && k < 60; k++) { const d = dayShift(today, -k); if (isWork(d)) pastDays.push(d); }
  const futureDays: Date[] = [];
  for (let k = 1; futureDays.length < 8 && k < 40; k++) { const d = dayShift(today, k); if (isWork(d)) futureDays.push(d); }
  const closedDay = futureDays[6]; // whole-day closure (staff development day)
  const meetingDay = futureDays[2]; // 1:00 PM blocked (faculty meeting)
  const blockedKey = new Set<string>([`${formatLabel(closedDay)}|*`, `${formatLabel(meetingDay)}|1:00 PM`]);

  type Appt = { day: Date; label: string; time: string; stu: Stu; service: string; status: string; purpose: string; cancelReason?: string; bookedBy?: string; resched?: number; created: Date; code?: string; refId?: string; orgId?: string };
  const appts: Appt[] = [];
  const usedSlots = new Set<string>();
  const usedStu = new Set<string>();
  const GENERAL_PURPOSES = ["Enrollment verification consult", "Scholarship requirements inquiry", "Clearance signing", "Good moral certificate request", "Shifting / change of course inquiry", "Certification of enrollment", "Organization accreditation inquiry", "Follow-up on a previous concern", "Consultation on leave of absence"];
  const CANCEL_REASONS = ["Student has a conflicting class schedule", "Booked by mistake — will rebook", "Student is unwell", "Concern was resolved over email", "Slot moved at the student's request"];
  const repStudents = [pedro, maria, byName("Liza Manguba")];
  const orgOf = (s: Stu) => (s.sn === pedro.sn ? orgCs : s.sn === maria.sn ? orgJe : orgAc);

  function newAppt(day: Date, status: string, o: { time?: string; service?: string; created?: Date } = {}): Appt | null {
    const label = formatLabel(day);
    if (blockedKey.has(`${label}|*`)) return null;
    const service = o.service || (() => { const r = rnd(); return r < 0.58 ? "GENERAL" : r < 0.7 ? "PSYCH" : r < 0.78 ? "EVENT" : r < 0.89 ? "AUTH" : "EXCUSE"; })();
    const free = SLOTS.filter((t) => !usedSlots.has(`${label}|${t}`) && !blockedKey.has(`${label}|${t}`));
    const time = o.time && free.includes(o.time) ? o.time : pick(free);
    if (!time) return null;
    let stu: Stu | undefined;
    const pool = service === "EVENT" ? repStudents : reg;
    for (let tries = 0; tries < 30 && !stu; tries++) { const c = pick(pool); if (!usedStu.has(`${label}|${c.sn}`)) stu = c; }
    if (!stu) return null;
    usedSlots.add(`${label}|${time}`); usedStu.add(`${label}|${stu.sn}`);
    const purpose = service === "GENERAL" ? pick(GENERAL_PURPOSES) : service === "AUTH" ? "Authentication Pickup" : service === "EXCUSE" ? "Excuse Slip Pickup" : service === "EVENT" ? "Event consultation" : "";
    const created = o.created || onDay(dayShift(day, -between(1, 6)), between(9, 16));
    const a: Appt = { day, label, time, stu, service, status, purpose, created, orgId: service === "EVENT" ? orgOf(stu).id : undefined };
    if ((service === "AUTH" || service === "EXCUSE") && status === "PENDING_APPROVAL") { a.status = "BOOKED"; a.bookedBy = "SSO Admin"; }
    appts.push(a);
    return a;
  }

  for (const day of pastDays) {
    for (let n = between(2, 5); n > 0; n--) {
      const r = rnd();
      const a = newAppt(day, r < 0.72 ? "SERVED" : r < 0.8 ? "NO_SHOW" : "CANCELLED");
      if (a && a.status === "CANCELLED") a.cancelReason = pick(CANCEL_REASONS);
    }
  }
  if (isWork(today)) {
    const nowMin = manilaMinutesNow();
    const todaySlots = [...SLOTS].sort((a, b) => minutesOfSlot(a) - minutesOfSlot(b)).slice(0, 9);
    let checkedInUsed = false;
    for (const t of todaySlots) {
      const m = minutesOfSlot(t);
      let status = "BOOKED";
      if (m + 15 < nowMin) status = chance(0.1) ? "NO_SHOW" : "SERVED";
      else if (!checkedInUsed && m <= nowMin + 30 && m + 15 >= nowMin) { status = "CHECKED_IN"; checkedInUsed = true; }
      else if (chance(0.22)) status = "PENDING_APPROVAL";
      newAppt(today, status, { time: t, created: dayShift(onDay(today, between(9, 16)), -between(1, 3)) });
    }
    const late = appts.filter((a) => a.label === formatLabel(today) && a.status === "BOOKED");
    if (late.length > 2) { late[late.length - 1].status = "PENDING_APPROVAL"; late[1].status = "CANCELLED"; late[1].cancelReason = pick(CANCEL_REASONS); }
  }
  for (const day of futureDays) {
    for (let n = between(2, 4); n > 0; n--) {
      const r = rnd();
      const a = newAppt(day, r < 0.24 ? "PENDING_APPROVAL" : r < 0.32 ? "RESCHEDULED" : "BOOKED", { created: dayShift(onDay(today, between(8, 16)), -between(0, 3)) });
      if (a && a.status === "RESCHEDULED") a.resched = 1;
      if (a && a.status === "BOOKED" && chance(0.15)) a.bookedBy = "SSO Admin";
    }
  }
  appts.sort((a, b) => a.created.getTime() - b.created.getTime());
  appts.forEach((a, i) => { a.code = `APT-${String(i + 1).padStart(3, "0")}`; });

  // ── linked records, one per appointment where the flow calls for it ──
  type Hist = { ts: string; status: string; by: string; note?: string };
  const flowOf = (kind: "GEN" | "PICKUP"): string[] => (kind === "GEN" ? ["Pending Review", "Approved", "Completed"] : ["Pending Review", "Approved", "Ready for Pickup", "Pickup Scheduled", "Completed"]);
  function flowHist(flow: string[], upto: string, who: string, staff: string, start: Date, notes: Record<string, string> = {}): Hist[] {
    const out: Hist[] = []; let t = new Date(start);
    for (const st of flow) {
      out.push({ ts: stamp(t), status: st, by: st === flow[0] ? who : staff, ...(notes[st] ? { note: notes[st] } : {}) });
      if (st === upto) break;
      t = new Date(t.getTime() + between(3, 20) * 3600000);
    }
    return out;
  }
  const AUTH_SUBJECTS = ["Authentication of Transcript of Records for scholarship application", "Authentication of Diploma for employment requirements", "Authentication of Certificate of Registration for passport application", "Authentication of Certificate of Grades for bank loan"];
  const AUTH_DETAILS = ["Needed for a scholarship renewal at the provincial office. Please authenticate the attached copy.", "Requested by my prospective employer — original documents will be presented upon pickup.", "For DFA passport appointment; needs the dry seal of the Office of Student Services.", "Bank requires authenticated copies for an educational loan application."];
  const EXCUSE_REASONS = ["Absent due to fever and a doctor's advice to rest for three days. Medical certificate attached.", "Family emergency — had to travel to the province for a relative's hospitalization.", "Represented the university in an inter-campus competition (official school activity).", "Attended a mandatory barangay youth assembly that conflicted with classes."];
  const REF_CATS = ["Psychological Intervention", "Psychological Intervention", "Academic Concern", "Career Guidance", "Personal / Family Concern"];
  const EVENT_DEFS = [
    { title: "Tech Talk: Careers in Cloud and DevOps", type: "Seminar", venue: "AVR Room 201", participants: "80" },
    { title: "General Assembly — Second Semester", type: "General Assembly", venue: "PUP San Pedro Gymnasium", participants: "150" },
    { title: "Business Plan Pitching Night", type: "Competition", venue: "Function Hall", participants: "60" },
    { title: "Teaching Demo Workshop for Education Majors", type: "Workshop", venue: "Room 305", participants: "40" },
    { title: "Freshmen Orientation Mixer", type: "Social", venue: "Covered Court", participants: "120" },
  ];
  const FB_BY_RATING: Record<number, string[]> = {
    5: ["Staff were very accommodating and the visit was quick.", "Smooth process — got my document the same day.", "Very polite and clear instructions, thank you!", ""],
    4: ["Good service, though the waiting area was a bit crowded.", "Fast enough, I just wish there were more slots in the morning.", ""],
    3: ["Okay overall, but I waited longer than my scheduled time.", ""],
    2: ["I had to come back because the requirements were unclear.", "Long waiting time even with an appointment."],
    1: ["Appointment was delayed by almost an hour."],
  };
  const ratingDraw = () => { const r = rnd(); return r < 0.55 ? 5 : r < 0.83 ? 4 : r < 0.93 ? 3 : r < 0.98 ? 2 : 1; };

  const reqRows: Array<Record<string, unknown>> = [];
  const refRows: Array<Record<string, unknown>> = [];
  const evtRows: Array<Record<string, unknown>> = [];
  const feedbackRows: Array<{ requestId: string; studentId: string; rating: number; comment: string; createdAt: Date }> = [];
  const STAFF = "SSO Admin";

  for (const a of appts) {
    const slotStart = parseSlotStart(a.label, a.time);
    const linkBase = { appointmentCode: a.code!, dateLabel: a.label, time: a.time, slotStartAt: slotStart };
    if (a.service === "GENERAL") {
      const id = rid("GEN"); a.refId = id;
      const statusMap: Record<string, string> = { SERVED: "Completed", CANCELLED: "Cancelled", NO_SHOW: "Cancelled", BOOKED: "Approved", CHECKED_IN: "Approved", RESCHEDULED: "Approved", PENDING_APPROVAL: "Pending Review" };
      const st = statusMap[a.status];
      let history: Hist[];
      if (st === "Cancelled") history = [...flowHist(["Pending Review", "Approved"], "Approved", a.stu.name, STAFF, a.created), { ts: stamp(onDay(a.day, 8)), status: "Cancelled", by: a.status === "NO_SHOW" ? STAFF : a.stu.name, note: a.status === "NO_SHOW" ? "Marked no-show." : a.cancelReason }];
      else history = flowHist(flowOf("GEN"), st, a.stu.name, STAFF, a.created);
      reqRows.push({ id, sn: a.stu.sn, name: a.stu.name, service: "GENERAL_VISIT", subject: "General SSO visit", details: `${a.purpose}.`, copies: 1, status: st, remarks: st === "Cancelled" ? (a.cancelReason || "No-show on the scheduled date.") : "", history, ...linkBase, createdAt: a.created });
      if (a.status === "SERVED" && chance(0.62)) { const rating = ratingDraw(); feedbackRows.push({ requestId: id, studentId: a.stu.sn, rating, comment: pick(FB_BY_RATING[rating]), createdAt: onDay(a.day, 15, between(0, 50)) }); }
    } else if (a.service === "AUTH" || a.service === "EXCUSE") {
      const id = rid(a.service === "AUTH" ? "AUT" : "EXC"); a.refId = id;
      const st = a.status === "SERVED" ? "Completed" : a.status === "CANCELLED" ? "Cancelled" : "Pickup Scheduled";
      const i = between(0, 3);
      const history = st === "Cancelled" ? [...flowHist(flowOf("PICKUP"), "Pickup Scheduled", a.stu.name, STAFF, a.created), { ts: stamp(onDay(a.day, 8)), status: "Cancelled", by: a.stu.name, note: a.cancelReason }] : flowHist(flowOf("PICKUP"), st, a.stu.name, STAFF, a.created);
      reqRows.push({ id, sn: a.stu.sn, name: a.stu.name, service: a.service === "AUTH" ? "AUTHENTICATION" : "EXCUSE_SLIP", subject: a.service === "AUTH" ? AUTH_SUBJECTS[i] : "Excuse slip request", details: a.service === "AUTH" ? AUTH_DETAILS[i] : EXCUSE_REASONS[i], copies: between(1, 3), status: st, remarks: "", history,
        appointmentCode: a.code!, pickupDate: a.label, pickupTime: a.time, pickupNote: st === "Cancelled" ? "" : "Bring one valid ID.", pickedUpAt: st === "Completed" ? onDay(a.day, 9) : null, createdAt: a.created });
    } else if (a.service === "PSYCH") {
      const id = rid("REF"); a.refId = id;
      const map: Record<string, string> = { SERVED: "Completed", BOOKED: "Confirmed", RESCHEDULED: "Confirmed", CHECKED_IN: "Checked In", PENDING_APPROVAL: "Pending", CANCELLED: "Cancelled", NO_SHOW: "No Show" };
      const st = map[a.status];
      const flow = ["Pending", "Under Review", "Approved", "Confirmed", "Checked In", "In Progress", "Completed"];
      const upto = ["Cancelled", "No Show"].includes(st) ? "Confirmed" : st;
      const history: Hist[] = flowHist(flow, upto, a.stu.name, STAFF, a.created);
      if (["Cancelled", "No Show"].includes(st)) history.push({ ts: stamp(onDay(a.day, 9)), status: st, by: st === "No Show" ? STAFF : a.stu.name, note: a.cancelReason });
      refRows.push({ id, sn: a.stu.sn, name: a.stu.name, category: pick(REF_CATS), details: "Requesting a counselling session. Details will be discussed in person with the guidance counselor.", status: st, remarks: "", history, appointmentCode: a.code!, appointmentDate: a.label, appointmentTime: a.time, createdAt: a.created });
    } else if (a.service === "EVENT") {
      const id = rid("EVT"); a.refId = id;
      const def = pick(EVENT_DEFS);
      const eventDay = dayShift(a.day, between(10, 21));
      const st = a.status === "PENDING_APPROVAL" ? "Pending" : a.status === "CANCELLED" ? "Rejected" : "Approved";
      const org = orgOf(a.stu);
      const history: Hist[] = [{ ts: stamp(a.created), status: "Pending", by: a.stu.name }];
      if (st !== "Pending") history.push({ ts: stamp(new Date(a.created.getTime() + between(5, 30) * 3600000)), status: st, by: STAFF, ...(st === "Rejected" ? { note: "Venue is already reserved for that date." } : {}) });
      evtRows.push({ id, sn: a.stu.sn, name: a.stu.name, title: def.title, org: org.name, organizationId: org.id, adviser: org.adviserName, date: formatLabel(eventDay), time: pick(["9:00 AM", "1:00 PM", "2:00 PM", "3:00 PM"]), venue: def.venue, participants: def.participants, budget: "", desc: `${def.title} organized by ${org.name} for PUP San Pedro students.`, type: def.type, status: st, history, appointmentCode: a.code!, appointmentDate: a.label, appointmentTime: a.time, createdAt: a.created });
    }
  }

  // FAQ categories (aligned with every active STARS module & deep-link allowlist).
  for (const name of [
    "Appointments",
    "Student ID",
    "Service Requests",
    "Events",
    "QR Pass & Scanner",
    "Account & Security",
    "General",
  ]) {
    await prisma.faqCategory.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Comprehensive, system-accurate FAQs (idempotent upsert so existing DBs get updated).
  const seededFaqs = [
    {
      id: "FAQ-SEED1",
      cat: "Service Requests",
      q: "How do I request Authentication or an Excuse Slip?",
      a: "Authentication and Excuse Slip are request-first services (no direct slot booking):\n1. Open Book Appointment and choose Authentication or Excuse Slip.\n2. Enter the purpose, number of copies, and attach supporting documents if needed, then submit.\n3. Track progress under My Appointments (Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed).\n4. Once ready, SSO staff schedule your pickup and generate an APT-### appointment with an offline QR pass.",
    },
    {
      id: "FAQ-SEED2",
      cat: "Appointments",
      q: "How will I know my appointment is confirmed?",
      a: "Student bookings start as Pending Approval until an SSO Admin reviews them. Once approved:\n1. Status changes to Confirmed under My Appointments (and your Dashboard Upcoming card).\n2. You receive an in-app notification and a confirmation email containing your APT-### code and an embedded offline QR pass.",
    },
    {
      id: "FAQ-SEED3",
      cat: "Student ID",
      q: "What do I need to bring when claiming my ID?",
      a: "Bring one valid ID and your Appointment QR Pass (saved PNG, printed slip, or embedded email QR) along with your APT-### / IDA- reference number. No payment is required.",
    },
    {
      id: "FAQ-SEED4",
      cat: "Student ID",
      q: "Is there a payment for a lost ID replacement?",
      a: "No payment is required for a lost ID replacement. Upload your OR receipt and a signed Affidavit of Loss in the ID Application module (you can download the affidavit template from Forms & Downloads).",
    },
    {
      id: "FAQ-SEED5",
      cat: "Events",
      q: "How early should our org file an event request?",
      a: "Submit event requests at least 10 working days before the event date, with your adviser's endorsement attached. Only an active organization representative can file event requests.",
    },
    {
      id: "FAQ-SEED6",
      cat: "General",
      q: "What are the SSO office hours?",
      a: "PUP San Pedro Student Services Office hours are Monday to Friday, 8:00 AM – 5:00 PM (Philippine Time, no noon break). The office is closed on weekends and declared holidays.",
    },
    {
      id: "FAQ-SEED7",
      cat: "Service Requests",
      q: "How do I request an Excuse Slip?",
      a: "1. Open Book Appointment and select Excuse Slip.\n2. Fill in your purpose/reason, number of copies, and upload supporting documents (e.g. medical certificate).\n3. Wait for SSO review — once approved and ready, the SSO schedules your pickup and sends your APT-### code and offline QR pass.",
    },
    {
      id: "FAQ-SEED8",
      cat: "Service Requests",
      q: "How do I track my Authentication or Excuse Slip request?",
      a: "Open My Appointments (or click the Upcoming / My Visits shortcut on your Dashboard) to view all open requests and synced pickups. Follow the steps: Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed. You can also paste your AUT- or EXC- reference code right here in chat.",
    },
    {
      id: "FAQ-SEED9",
      cat: "Events",
      q: "Who can file an event request for our organization?",
      a: "Only an active organization representative assigned by SSO staff may file an event request. Attach your adviser's endorsement at least 10 working days before the event. Booking an Event consultation appointment is optional and syncs automatically to the event request.",
    },
    {
      id: "FAQ-SEED10",
      cat: "QR Pass & Scanner",
      q: "How do I get and use my offline Appointment QR Pass?",
      a: "Every confirmed appointment and scheduled pickup includes a tamper-evident offline QR pass:\n1. Open My Appointments (or click Next Appointment on your Dashboard) and click View.\n2. Click Download PNG or Print Pass before going to campus, or use the QR pass attached to your confirmation/pickup email.\n3. Present it at the SSO Service Desk — staff can scan it even when the portal link cannot be accessed.",
    },
    {
      id: "FAQ-SEED11",
      cat: "QR Pass & Scanner",
      q: "How does check-in with the QR scanner work at the SSO desk?",
      a: "Show your saved PNG, printed QR pass, or email QR at the SSO Service Desk. Staff scan the signed QR code to verify your appointment immediately, check you in, and mark your visit or pickup completed — which also automatically updates your linked Service Request or ID Application.",
    },
    {
      id: "FAQ-SEED12",
      cat: "Account & Security",
      q: "How do I create a student account in STARS?",
      a: "1. Click Register here on the sign-in page and enter your details + official PUP San Pedro Student Number (must exist in the SSO masterlist).\n2. Enter your Gmail or PUP email address and click Send OTP to receive a 6-digit verification code (valid for 10 minutes).\n3. Create a strong password (more than 8 characters, with uppercase, lowercase, a number, and a special character) and confirm it.\n4. Submit and wait for SSO Admin approval before signing in.",
    },
    {
      id: "FAQ-SEED13",
      cat: "Account & Security",
      q: "What are the password requirements for STARS accounts?",
      a: "Passwords must be strictly more than 8 characters (9–128 characters) and contain at least one uppercase letter (A–Z), one lowercase letter (a–z), one number (0–9), and one special character (such as !@#$%^&*). Passwords cannot contain your student number or email username.",
    },
    {
      id: "FAQ-SEED14",
      cat: "Account & Security",
      q: "How do I reset or change my password?",
      a: "If you forgot your password, click Forgot password? on the sign-in page and open the reset link sent to your email. If you are already signed in, go to Account → Change Password. Both require a strong password (9+ chars with uppercase, lowercase, number, and special character).",
    },
    {
      id: "FAQ-SEED15",
      cat: "Appointments",
      q: "How do I book a General Visit, Event Consultation, or Counseling appointment?",
      a: "1. Open Book Appointment and choose General Visit, Event Request, or Psychological Intervention.\n2. Select an available weekday (Monday–Friday, within the current or next month) and an open time slot.\n3. Submit your booking — once approved by the SSO Admin, you receive a confirmed APT-### code and offline QR pass. Limit: one active appointment per student per date.",
    },
    {
      id: "FAQ-SEED16",
      cat: "Appointments",
      q: "How do I reschedule or cancel my appointment?",
      a: "Open My Appointments and click Reschedule or Cancel on your active booking. Rules: a 24-hour cutoff applies before the original slot, you can reschedule up to 2 times (keeping the same APT-### code), and cancelled codes are never reused. Past or no-show visits are read-only history.",
    },
    {
      id: "FAQ-SEED17",
      cat: "Appointments",
      q: "What happens if I miss my appointment (No Show)?",
      a: "Missed appointments are marked as No Show and become read-only history. If you still need assistance, book a new available weekday slot. For missed document/ID pickups, your request returns to Ready for Pickup so SSO staff can schedule a new pickup slot.",
    },
    {
      id: "FAQ-SEED18",
      cat: "Student ID",
      q: "How do I apply for a New Student ID?",
      a: "1. Open ID Application and select New.\n2. Upload your Official Receipt (OR) and enter the required details.\n3. Track progress: Pending → OR Verified → Approved → Processing → Ready for Claiming.\n4. When ready, the SSO schedules your pickup with an APT-### code and offline QR pass. Bring one valid ID when claiming.",
    },
    {
      id: "FAQ-SEED19",
      cat: "General",
      q: "How do the Dashboard KPI shortcuts work?",
      a: "On your Student Dashboard, the top summary cards act as direct shortcuts: click My Visits to view all transactions, Upcoming to view active bookings and scheduled pickups, Served to view completed history, or Next Appointment to open your upcoming appointment details and QR pass right away.",
    },
    {
      id: "FAQ-SEED20",
      cat: "General",
      q: "How do Psychological Intervention and Referrals work?",
      a: "The SSO offers confidential 45-minute Psychological Intervention sessions. File a Referral or book a Psychological Intervention visit under Book Appointment. Details are private — only you and authorized SSO admins can view them, scanner views display 'Reserved — Confidential', and the chatbot never reads referral records.",
    },
    {
      id: "FAQ-SEED21",
      cat: "General",
      q: "How do I file a student complaint?",
      a: "Open the Complaints module, select a category, describe your concern, attach evidence if needed, and choose Standard or Confidential handling. For privacy, the chatbot cannot read or display complaint details; SSO staff follow up through official channels.",
    },
    {
      id: "FAQ-SEED22",
      cat: "General",
      q: "Where can I download official SSO forms and templates?",
      a: "Open Forms & Downloads from the sidebar to download official templates such as the Affidavit of Loss (for Lost ID replacement) and the Event Clearance Checklist.",
    },
    {
      id: "FAQ-SEED23",
      cat: "General",
      q: "How do Help Desk support tickets work?",
      a: "If you have an issue the assistant cannot resolve, open Help Desk and click + New Ticket (or use the Create Ticket option in chat). Staff reply directly inside the thread (Open → Answered → Closed). Tickets are closed by SSO staff once resolved.",
    },
    {
      id: "FAQ-SEED24",
      cat: "Account & Security",
      q: "How do I update my name, email, course, or year level?",
      a: "Open your Account page and submit a Profile Change request. All profile updates go through SSO staff verification before taking effect, and you will be notified once approved.",
    },
  ];
  for (const f of seededFaqs) {
    await prisma.faq.upsert({
      where: { id: f.id },
      update: { cat: f.cat, q: f.q, a: f.a },
      create: f,
    });
  }



  // ───────────────────────── request-first items that have no appointment yet ─────────────────────────
  const dayAt = (n: number, h = between(9, 16)) => onDay(dayShift(today, -n), h);
  const pend = (flow: string[], upto: string) => flow.slice(0, flow.indexOf(upto) + 1);
  const standalone: Array<{ who: string; service: "AUTHENTICATION" | "EXCUSE_SLIP"; status: string; ago: number; i: number; remarks?: string }> = [
    { who: "Angelica Bautista", service: "EXCUSE_SLIP", status: "Pending Review", ago: 0, i: 0 },
    { who: "Joshua Lim", service: "AUTHENTICATION", status: "Pending Review", ago: 1, i: 1 },
    { who: "Trisha Gonzales", service: "EXCUSE_SLIP", status: "Pending Review", ago: 1, i: 2 },
    { who: "Camille Agustin", service: "AUTHENTICATION", status: "Approved", ago: 2, i: 0 },
    { who: "Miguel Tolentino", service: "EXCUSE_SLIP", status: "Approved", ago: 3, i: 3 },
    { who: "Denise Cabrera", service: "AUTHENTICATION", status: "Ready for Pickup", ago: 4, i: 2 },
    { who: "Gabriel Santiago", service: "AUTHENTICATION", status: "Ready for Pickup", ago: 5, i: 1 },
    { who: "Paolo Mendoza", service: "EXCUSE_SLIP", status: "Needs Revision", ago: 3, i: 1, remarks: "Please attach a clear scan of your medical certificate." },
    { who: "Carlo Pascual", service: "AUTHENTICATION", status: "Rejected", ago: 6, i: 3, remarks: "The submitted copy is not a PUP-issued document and cannot be authenticated." },
    { who: "Kristine Salazar", service: "EXCUSE_SLIP", status: "Completed", ago: 9, i: 2 },
  ];
  for (const s of standalone) {
    const stu = byName(s.who);
    const created = dayAt(s.ago);
    const flow = flowOf("PICKUP");
    const bad = ["Needs Revision", "Rejected"].includes(s.status);
    const history: Hist[] = bad
      ? [...flowHist(["Pending Review"], "Pending Review", stu.name, STAFF, created), { ts: stamp(new Date(created.getTime() + 6 * 3600000)), status: s.status, by: STAFF, note: s.remarks }]
      : flowHist(pend(flow, s.status), s.status, stu.name, STAFF, created);
    reqRows.push({ id: rid(s.service === "AUTHENTICATION" ? "AUT" : "EXC"), sn: stu.sn, name: stu.name, service: s.service, subject: s.service === "AUTHENTICATION" ? AUTH_SUBJECTS[s.i] : "Excuse slip request", details: s.service === "AUTHENTICATION" ? AUTH_DETAILS[s.i] : EXCUSE_REASONS[s.i], copies: between(1, 2), status: s.status, remarks: s.remarks || "", history, appointmentCode: null, dateLabel: "", time: "", slotStartAt: null, pickupDate: "", pickupTime: "", pickupNote: "", pickedUpAt: s.status === "Completed" ? dayAt(s.ago - 2, 10) : null, createdAt: created });
  }

  // ── ID applications (receipt + affidavit files are written so the links open) ──
  const idSpecs = [
    { who: "Bea Castillo", type: "New ID", status: "Pending", ago: 0, reason: "First-year student — first-time ID issuance." },
    { who: "Jasmine Villanueva", type: "New ID", status: "Pending", ago: 1, reason: "First-year student — first-time ID issuance." },
    { who: "Mark Anthony Ramos", type: "New ID", status: "OR Verified", ago: 2, reason: "First-year student — first-time ID issuance." },
    { who: "Nathaniel Soriano", type: "ID Replacement — Damaged", status: "Needs Revision", ago: 3, reason: "ID cracked in half; the old ID is attached for surrender.", remarks: "The photo of the damaged ID is blurry — please upload a clearer one." },
    { who: "Ronnie Alcantara", type: "ID Replacement — Lost", status: "Approved", ago: 4, reason: "Lost the ID on the way home from school." },
    { who: "Francine Domingo", type: "ID Replacement — Lost", status: "Processing", ago: 6, reason: "ID misplaced during the enrollment period." },
    { who: "Patricia Evangelista", type: "ID Replacement — Damaged", status: "Ready for Claiming", ago: 8, reason: "Magnetic strip no longer scans at the gate." },
    { who: "Joshua Lim", type: "New ID", status: "Claimed", ago: 14, reason: "Transferee — first PUP San Pedro ID." },
    { who: "Camille Agustin", type: "ID Replacement — Lost", status: "Claimed", ago: 19, reason: "Lost the ID during an OJT trip." },
    { who: "Miguel Tolentino", type: "ID Replacement — Lost", status: "Rejected", ago: 11, reason: "Lost ID.", remarks: "Affidavit of Loss is missing a notary seal. Please resubmit." },
  ];
  const idFlow = ["Pending", "OR Verified", "Approved", "Processing", "Ready for Claiming", "Claimed"];
  const idRows: Array<Record<string, unknown>> = [];
  idSpecs.forEach((s, n) => {
    const stu = byName(s.who);
    const id = rid("IDA");
    const created = dayAt(s.ago);
    const orNo = `26-${String(41200 + n * 17)}`;
    const orUrl = `/uploads/documents/or-${id.toLowerCase()}.svg`;
    writeFileEnsured(`uploads/documents/or-${id.toLowerCase()}.svg`, receiptSvg(orNo, stu.name, s.type === "New ID" ? "150.00" : "200.00", s.type === "New ID" ? "Student ID — new issuance" : "Student ID — replacement fee", formatLabel(created)));
    const lost = s.type.includes("Lost");
    const affUrl = lost ? `/uploads/documents/affidavit-${id.toLowerCase()}.svg` : null;
    if (lost) writeFileEnsured(`uploads/documents/affidavit-${id.toLowerCase()}.svg`, affidavitSvg(stu.name, formatLabel(created)));
    const bad = ["Needs Revision", "Rejected"].includes(s.status);
    const history: Hist[] = bad ? [...flowHist(["Pending"], "Pending", stu.name, STAFF, created), { ts: stamp(new Date(created.getTime() + 8 * 3600000)), status: s.status, by: STAFF, note: s.remarks }] : flowHist(pend(idFlow, s.status), s.status, stu.name, STAFF, created);
    const pickupDay = s.status === "Ready for Claiming" ? futureDays[0] : s.status === "Claimed" ? dayShift(created, 6) : null;
    idRows.push({ id, sn: stu.sn, name: stu.name, type: s.type, reason: s.reason, orName: `OR-${orNo}`, orUrl, affidavitName: lost ? `Affidavit-of-Loss-${stu.name.split(" ").pop()}.pdf` : null, affidavitUrl: affUrl, status: s.status, remarks: s.remarks || "", history,
      pickupDate: pickupDay ? formatLabel(pickupDay) : "", pickupTime: pickupDay ? pick(["9:00 AM", "10:00 AM", "1:30 PM"]) : "", pickupNote: pickupDay ? "Bring one valid ID." : "", pickedUpAt: s.status === "Claimed" ? onDay(pickupDay!, 9, 20) : null, createdAt: created });
  });

  // ── complaints ──
  const complaintSpecs = [
    { who: "Trisha Gonzales", cat: "Facilities", details: "The faucet in the second-floor restroom has been leaking for two weeks and the floor gets slippery.", status: "Under Investigation", ago: 6, conf: "Standard", assigned: "SSO Admin", staff: "Forwarded to the maintenance office on the 22nd; waiting for a schedule.", note: "Maintenance has been notified and will inspect this week." },
    { who: "Joshua Lim", cat: "Academic Concern", details: "Grades for one subject have not been posted more than a month after the final exam.", status: "Submitted", ago: 2, conf: "Standard" },
    { who: "Denise Cabrera", cat: "Staff Conduct", details: "I was told to come back three times for the same signature without being given a reason.", status: "Under Investigation", ago: 9, conf: "Restricted", assigned: "SSO Admin", staff: "Spoke to the unit head; reviewing the queue logs for the dates mentioned." },
    { who: "Camille Agustin", cat: "Safety & Security", details: "The gate near the covered court is left unattended after 6 PM, and several students walk home through it.", status: "Resolved", ago: 18, conf: "Standard", assigned: "SSO Admin", staff: "Coordinated with the security agency.", note: "A guard is now posted at the gate until 8 PM. Thank you for the report." },
    { who: "Bea Castillo", cat: "Harassment / Bullying", details: "Details withheld — I would like to speak to a counselor in private.", status: "Under Investigation", ago: 4, conf: "Strictly Confidential", assigned: "SSO Super Admin", staff: "Initial interview scheduled with the guidance office." },
    { who: "Gabriel Santiago", cat: "Others", details: "The campus Wi-Fi drops every afternoon in the library, making it hard to submit online requirements.", status: "Resolved", ago: 24, conf: "Standard", assigned: "SSO Admin", staff: "Endorsed to the IT office.", note: "IT replaced the access point in the library. Please report if it persists." },
    { who: "Miguel Tolentino", cat: "Facilities", details: "Several chairs in Room 305 are broken and unsafe to use.", status: "Dismissed", ago: 12, conf: "Standard", assigned: "SSO Admin", staff: "Duplicate of an earlier report that is already being repaired.", note: "This concern is already covered by an earlier report that is being handled." },
  ];
  const complaintRows = complaintSpecs.map((c) => { const stu = byName(c.who); return { id: rid("CMP"), sn: stu.sn, name: stu.name, category: c.cat, details: c.details, status: c.status, note: c.note || "", confidentiality: c.conf, assignedTo: c.assigned || null, staffNotes: c.staff || "", createdAt: dayAt(c.ago) }; });

  // ── chat sessions with the assistant (some resolve, some escalate to tickets) ──
  const faq = (n: number) => seededFaqs[n - 1];
  const chats: Array<{ who: string; ago: number; subject: string; turns: Array<[string, number]> }> = [
    { who: "Juan dela Cruz", ago: 1, subject: "Excuse slip help", turns: [["How do I request an Excuse Slip?", 7], ["I need help with my specific case, my absence was because of a hospital admission.", 0]] },
    { who: "Rico Aguinaldo", ago: 1, subject: "Appointment not confirmed", turns: [["Bakit pending pa rin yung appointment ko?", 2], ["It's been two days already, can someone check my booking?", 0]] },
    { who: "Angelica Bautista", ago: 0, subject: "ID requirements", turns: [["What do I need to bring when claiming my ID?", 3]] },
    { who: "Mark Anthony Ramos", ago: 2, subject: "Lost ID", turns: [["Is there a payment for a lost ID replacement?", 4]] },
    { who: "Jasmine Villanueva", ago: 3, subject: "Booking steps", turns: [["How will I know my appointment is confirmed?", 2]] },
    { who: "Paolo Mendoza", ago: 3, subject: "Forms", turns: [["Where can I download official SSO forms and templates?", 22]] },
    { who: "Joshua Lim", ago: 5, subject: "Complaint process", turns: [["How do I file a student complaint?", 21]] },
    { who: "Trisha Gonzales", ago: 5, subject: "Profile change", turns: [["How do I update my name, email, course, or year level?", 24]] },
    { who: "Denise Cabrera", ago: 6, subject: "Help desk", turns: [["How do Help Desk support tickets work?", 23]] },
    { who: "Camille Agustin", ago: 8, subject: "Authentication", turns: [["How do I request Authentication?", 1]] },
    { who: "Gabriel Santiago", ago: 9, subject: "Unknown question", turns: [["can i get my diploma earlier than the graduation date", -1]] },
    { who: "Kristine Salazar", ago: 11, subject: "Unknown question", turns: [["where is the registrar's office located", -1]] },
    { who: "Carlo Pascual", ago: 13, subject: "Unknown question", turns: [["how many units can i take next sem", -1]] },
    { who: "Patricia Evangelista", ago: 14, subject: "Scanner", turns: [["Do I need to print my QR pass?", 11]] },
  ];
  const chatSessionIds = new Map<string, string>();
  for (const c of chats) {
    const stu = byName(c.who); const acct = accounts.get(stu.sn); if (!acct) continue;
    const created = dayAt(c.ago, between(9, 16));
    const sid = rid("CHT");
    await prisma.chatSession.deleteMany({ where: { id: sid } });
    const session = await prisma.chatSession.create({ data: { id: sid, userId: acct.id, studentId: stu.sn, subject: c.subject, createdAt: created } });
    chatSessionIds.set(stu.sn, session.id);
    let t = created.getTime();
    for (const [q, n] of c.turns) {
      t += 20_000;
      await prisma.chatMessage.create({ data: { sessionId: session.id, role: "student", text: q, createdAt: new Date(t) } });
      t += 3_000;
      if (n > 0) {
        const m = await prisma.chatMessage.create({ data: { sessionId: session.id, role: "assistant", text: faq(n).a, faqId: faq(n).id, confidence: "high", createdAt: new Date(t) } });
        if (chance(0.5)) await prisma.chatFeedback.create({ data: { messageId: m.id, sessionId: session.id, studentId: stu.sn, value: chance(0.88) ? 1 : -1, createdAt: new Date(t + 15_000) } });
      } else {
        await prisma.chatMessage.create({ data: { sessionId: session.id, role: "assistant", text: "I couldn't find a confident answer to that. I can create a support ticket so SSO staff can help you directly.", confidence: "low", createdAt: new Date(t) } });
      }
    }
  }

  // ── help-desk tickets ──
  type TMsg = { from: "student" | "admin"; by: string; text: string; ts: string };
  const tm = (from: "student" | "admin", by: string, text: string, d: Date): TMsg => ({ from, by, text, ts: stamp(d) });
  const ticketSpecs: Array<{ who: string; cat: string; subject: string; status: string; ago: number; thread: Array<["student" | "admin", string]>; chat?: boolean }> = [
    { who: "Rico Aguinaldo", cat: "Appointments", subject: "Booking still pending after two days", status: "Open", ago: 1, chat: true, thread: [["student", "My booking has been pending for two days. I'm worried the slot will be taken."]] },
    { who: "Juan dela Cruz", cat: "General", subject: "Excuse slip for hospital admission", status: "Answered", ago: 1, chat: true, thread: [["student", "I was confined in a hospital last week. Can I still request an excuse slip even if I'm already back in class?"], ["admin", "Hi Juan! Yes, you can. Please file an Excuse Slip request and attach your medical certificate. We will review it within the day."]] },
    { who: "Angelica Bautista", cat: "Student ID", subject: "Wrong spelling on my new ID", status: "Open", ago: 0, thread: [["student", "My middle name is misspelled on the ID photo preview. How can I correct it before it is printed?"]] },
    { who: "Nathaniel Soriano", cat: "Account & Security", subject: "Cannot sign in after changing password", status: "Answered", ago: 3, thread: [["student", "I changed my password yesterday and now it says invalid credentials."], ["admin", "Please try the Forgot Password link — a reset email will be sent to your registered address. Let us know if it doesn't arrive."]] },
    { who: "Francine Domingo", cat: "Appointments", subject: "How do I reschedule my visit?", status: "Closed", ago: 7, thread: [["student", "I have a class conflict on my appointment date. Can I move it?"], ["admin", "Open My Appointments, choose the booking, and tap Reschedule. You can move it up to two times, at least 24 hours before the visit."], ["student", "Got it, it worked. Thank you!"]] },
    { who: "Ronnie Alcantara", cat: "General", subject: "Requirements for scholarship endorsement", status: "Closed", ago: 10, thread: [["student", "What documents do I need for the scholarship endorsement letter?"], ["admin", "Please bring your COR, a copy of your latest grades, and the scholarship's endorsement form. You can book a General SSO Visit."]] },
    { who: "Carlo Pascual", cat: "Student ID", subject: "ID pickup schedule", status: "Closed", ago: 13, thread: [["student", "Is my replacement ID ready? I haven't received any notification."], ["admin", "It was released to the cashier's queue yesterday. We have scheduled a pickup for you — check your notifications."]] },
    { who: "Camille Agustin", cat: "Account & Security", subject: "Change of course in my profile", status: "Answered", ago: 4, thread: [["student", "I shifted courses last semester but my profile still shows my old one."], ["admin", "Please submit a Profile Change request from your Account page and attach proof of shifting. We'll verify it right away."]] },
    { who: "Gabriel Santiago", cat: "General", subject: "Diploma release date", status: "Open", ago: 2, chat: true, thread: [["student", "can i get my diploma earlier than the graduation date"]] },
  ];
  const ticketRows = ticketSpecs.map((t) => {
    const stu = byName(t.who); const created = dayAt(t.ago, between(9, 15));
    let ts = created.getTime();
    const msgs = t.thread.map(([from, text]) => { const m = tm(from, from === "student" ? stu.name : STAFF, text, new Date(ts)); ts += between(40, 400) * 60_000; return m; });
    return { id: rid("TKT"), sn: stu.sn, name: stu.name, category: t.cat, subject: t.subject, status: t.status, msgs, chatSessionId: t.chat ? chatSessionIds.get(stu.sn) ?? null : null, createdAt: created };
  });

  // ── pending profile changes (verification queue) ──
  const profileChanges = [
    { who: "Juan dela Cruz", email: "juan.delacruz@iskolarngbayan.pup.edu.ph", course: "BSCS", year: "3rd Year", ago: 1 },
    { who: "Ronnie Alcantara", email: "ronnie.alcantara@iskolarngbayan.pup.edu.ph", course: "BEED", year: "4th Year", ago: 2 },
  ];

  // ───────────────────────── bulletins, forms, memos ─────────────────────────
  const nextHoliday = holidays[0];
  const bulletins = [
    { id: rid("BUL"), title: "SSO Office Hours — Second Semester", category: "Announcement", body: "The Student Services Office is open Monday to Friday, 8:00 AM to 5:00 PM (closed 12:00–1:00 PM). Please book an appointment through STARS to avoid long waiting times. Walk-ins are accommodated after scheduled visits.", featured: true, status: "Published", ago: 20 },
    { id: rid("BUL"), title: "ID Validation and Claiming Schedule", category: "Announcement", body: "Student ID validation stickers are available at the SSO window until the end of the month. For new and replacement IDs, you will receive a notification with your pickup schedule once your ID is ready. Please bring one valid ID.", featured: false, status: "Published", ago: 12 },
    { id: rid("BUL"), title: "Reminder: File Event Requests 10 Working Days Ahead", category: "Reminder", body: "Organization representatives are reminded to file event requests at least ten (10) working days before the activity. Requests with incomplete details or without an adviser's endorsement will be returned for revision.", featured: false, status: "Published", ago: 9 },
    { id: rid("BUL"), title: "Organization Accreditation Renewal Is Now Open", category: "Org Event", body: "Student organizations may now submit renewal requirements for the current school year. Download the accreditation form under Forms & Downloads and book an Event Request consultation if you need guidance.", featured: false, status: "Published", ago: 6 },
    { id: rid("BUL"), title: nextHoliday ? `Advisory: Offices Closed on ${nextHoliday.date}` : "Advisory: Holiday Schedule", category: "Advisory", body: nextHoliday ? `In observance of ${nextHoliday.name}, the Student Services Office will be closed on ${nextHoliday.date}. Appointments on that date have been blocked in the calendar. Regular operations resume the next working day.` : "Please check the booking calendar for closed dates.", featured: false, status: "Published", ago: 3 },
    { id: rid("BUL"), title: "Authentication Requests Now Take Three Working Days", category: "Announcement", body: "To keep up with the volume of requests, Authentication of documents is now processed within three (3) working days from approval. You will be notified once your documents are ready for pickup.", featured: false, status: "Published", ago: 1 },
    { id: rid("BUL"), title: "Year-End Wellness Week", category: "Org Event", body: "The Guidance Unit is organizing a wellness week with free stress-management sessions and group counselling. Slots are limited — book a Psychological Intervention appointment to reserve a session.", featured: false, status: "Published", ago: -3 },
    { id: rid("BUL"), title: "Revised Guidelines for Excuse Slips", category: "Announcement", body: "Draft — pending approval from the Director's office. Will clarify the filing window and supporting documents.", featured: false, status: "Draft", ago: 1 },
  ];

  const formDefs = [
    { id: rid("FRM"), title: "Affidavit of Loss (ID Replacement)", file: "affidavit-of-loss-template.pdf", lines: ["Use this template when applying for a replacement of a lost Student ID.", "Fill in your full name, student number and the circumstances of the loss.", "The affidavit must be notarized before submission."] },
    { id: rid("FRM"), title: "Event Clearance Checklist", file: "event-clearance-checklist.pdf", lines: ["Requirements for filing an event request:", "1. Letter of request signed by the organization adviser", "2. Activity proposal with program flow and budget", "3. Venue reservation confirmation"] },
    { id: rid("FRM"), title: "Organization Accreditation Form", file: "organization-accreditation-form.pdf", lines: ["Annual accreditation / renewal of student organizations.", "Attach: list of officers, adviser's conformity, plan of activities."] },
    { id: rid("FRM"), title: "Excuse Slip Request Form", file: "excuse-slip-request-form.pdf", lines: ["For absences covered by an acceptable reason.", "Attach a medical certificate or an official activity memo."] },
    { id: rid("FRM"), title: "Authentication Request Form", file: "authentication-request-form.pdf", lines: ["List the documents you want authenticated and the number of copies.", "Bring the original documents on the pickup date."] },
    { id: rid("FRM"), title: "Student Complaint Form (Printable)", file: "student-complaint-form.pdf", lines: ["For students who prefer to submit a written complaint.", "You may also file online through the Complaints module."] },
  ];
  for (const f of formDefs) writeFileEnsured(`uploads/forms/${f.file}`, miniPdf(f.title, [...f.lines, "", "PUP San Pedro — Student Services Office"]));

  const regFirst = reg.filter((s) => s.year === "1st Year").length;
  const memos = [
    { id: rid("MEM"), subject: "Enrollment Schedule for the Second Semester", audienceLabel: "Registered Students (All courses and year levels)", recipients: reg.length, ago: 25 },
    { id: rid("MEM"), subject: "Reminder: Complete Your ID Validation This Month", audienceLabel: "Registered Students (1st Year)", recipients: regFirst, ago: 14 },
    { id: rid("MEM"), subject: nextHoliday ? `Office Advisory: ${nextHoliday.name} Schedule` : "Office Advisory", audienceLabel: "Registered Students (All courses and year levels)", recipients: reg.length, ago: 4 },
  ];

  // ───────────────────────── notifications, email log, audit trail ─────────────────────────
  const svcName = (k: string) => ({ GENERAL: "General SSO Visit", EVENT: "Event Request", PSYCH: "Psychological Intervention", AUTH: "Authentication", EXCUSE: "Excuse Slip" } as Record<string, string>)[k] || k;
  const notifs: Array<{ target: string; title: string; body: string; read: boolean; createdAt: Date }> = [];
  const recent = (d: Date) => today.getTime() - d.getTime() < 3 * 86400000;
  for (const a of appts) {
    if (a.status === "PENDING_APPROVAL") notifs.push({ target: "admin", title: "New Booking Request", body: `${a.stu.name} requested ${svcName(a.service)} on ${a.label}, ${a.time}.`, read: !recent(a.created), createdAt: a.created });
    if (today.getTime() - a.day.getTime() < 12 * 86400000 && ["BOOKED", "RESCHEDULED", "SERVED", "CANCELLED", "CHECKED_IN"].includes(a.status)) {
      const cancelled = a.status === "CANCELLED";
      notifs.push({ target: a.stu.sn, title: cancelled ? "Appointment Cancelled" : a.status === "RESCHEDULED" ? "Appointment Rescheduled" : "Appointment Confirmed", body: cancelled ? `Your visit ${a.code} on ${a.label} was cancelled.` : `Your visit ${a.code} (${svcName(a.service)}) is confirmed for ${a.label}, ${a.time}.`, read: a.day.getTime() < today.getTime() - 86400000, createdAt: new Date(a.created.getTime() + 3 * 3600000) });
    }
  }
  for (const r of reqRows) if (r.status === "Pending Review" && !r.appointmentCode) notifs.push({ target: "admin", title: `New ${r.service === "AUTHENTICATION" ? "Authentication" : "Excuse Slip"} Request`, body: `${r.name} filed ${r.id} — awaiting review.`, read: false, createdAt: r.createdAt as Date });
  for (const r of idRows) if (r.status === "Pending") notifs.push({ target: "admin", title: "New ID Application", body: `${r.name} filed ${r.id} (${r.type}).`, read: false, createdAt: r.createdAt as Date });
  for (const c of complaintRows) if (c.status === "Submitted") notifs.push({ target: "admin", title: "New Complaint Filed", body: `A ${c.category} complaint (${c.id}) was submitted.`, read: false, createdAt: c.createdAt });
  for (const t of ticketRows) if (t.status === "Open") notifs.push({ target: "admin", title: "New Help Desk Ticket", body: `${t.name} opened ${t.id}: ${t.subject}.`, read: false, createdAt: t.createdAt });
  for (const r of reqRows) if (["Ready for Pickup", "Pickup Scheduled"].includes(r.status as string) && (r.createdAt as Date).getTime() > today.getTime() - 10 * 86400000) notifs.push({ target: r.sn as string, title: r.status === "Ready for Pickup" ? "Your Documents Are Ready" : "Pickup Scheduled", body: r.status === "Ready for Pickup" ? `Your request ${r.id} is ready for pickup. We will notify you of the schedule.` : `Pickup for ${r.id} is set for ${r.pickupDate}, ${r.pickupTime}.`, read: chance(0.5), createdAt: new Date((r.createdAt as Date).getTime() + 30 * 3600000) });
  memos.forEach((m, idx) => { for (const s of reg) { if (m.audienceLabel.includes("1st Year") && s.year !== "1st Year") continue; notifs.push({ target: s.sn, title: `Memo: ${m.subject}`, body: "Open the Notifications panel to read the full memorandum from the Student Services Office.", read: idx < memos.length - 1 ? true : chance(0.4), createdAt: dayAt(m.ago, 9) }); } });

  const emails: Array<{ to: string; name: string; ref: string; doc: string; status: string; mode: string; createdAt: Date }> = [];
  for (const a of appts) {
    if (today.getTime() - a.day.getTime() > 14 * 86400000 || !["BOOKED", "SERVED", "RESCHEDULED", "CHECKED_IN"].includes(a.status)) continue;
    emails.push({ to: a.stu.email, name: a.stu.name, ref: a.code!, doc: "Appointment", status: "Success", mode: "SENT", createdAt: new Date(a.created.getTime() + 3 * 3600000) });
  }
  for (const r of reqRows) if (["Ready for Pickup", "Pickup Scheduled", "Completed"].includes(r.status as string) && (r.createdAt as Date).getTime() > today.getTime() - 14 * 86400000) { const s = students.find((x) => x.sn === r.sn)!; emails.push({ to: s.email, name: s.name, ref: r.id as string, doc: r.service === "AUTHENTICATION" ? "Authentication" : "Request update", status: "Success", mode: "SENT", createdAt: new Date((r.createdAt as Date).getTime() + 28 * 3600000) }); }
  memos.forEach((m, idx) => { if (idx < 2) emails.push({ to: "(blast)", name: "Memo blast", ref: m.id, doc: m.subject, status: "Success", mode: "SENT", createdAt: dayAt(m.ago, 9) }); });
  emails.push({ to: "kyle.navarro@iskolarngbayan.pup.edu.ph", name: "Kyle Navarro", ref: "OTP", doc: "Verification code", status: "Failed", mode: "FAILED", createdAt: dayAt(5, 14) } as never);

  const audit: Array<{ type: "INFO" | "WARN" | "ERROR"; msg: string; createdAt: Date }> = [];
  const A = (type: "INFO" | "WARN" | "ERROR", msg: string, createdAt: Date) => audit.push({ type, msg, createdAt });
  const nowMs = Date.now();
  for (const day of [...pastDays.slice().reverse(), ...(isWork(today) ? [today] : [])]) {
    const isToday = formatLabel(day) === formatLabel(today);
    const at = (h: number, m: number) => { const d = onDay(day, h, m); return d; };
    const staffIn = at(7, between(40, 59));
    if (staffIn.getTime() < nowMs) { A("INFO", "Scanner Desk signed in successfully.", at(7, between(30, 55))); A("INFO", "SSO Admin signed in successfully.", staffIn); }
    if (!isToday) { A("INFO", "SSO Admin signed out.", at(17, between(0, 20))); A("INFO", "Scanner Desk signed out.", at(17, between(0, 15))); }
    for (let n = between(5, 12); n > 0; n--) { const s = pick(reg); const t = at(between(6, 21), between(0, 59)); if (t.getTime() < nowMs) A("INFO", `${s.name} signed in successfully.`, t); if (chance(0.55)) { const o = new Date(t.getTime() + between(5, 60) * 60000); if (o.getTime() < nowMs) A("INFO", `${s.name} signed out.`, o); } }
    if (chance(0.18)) A("WARN", `Failed login attempt for "${pick(["student@gmail.com", pick(students).sn, "admin2@pup.edu.ph", "juan.cruz"])}".`, at(between(7, 22), between(0, 59)));
  }
  for (const a of appts) {
    const d = `${a.code} (${svcName(a.service)})`;
    const slot = parseSlotStart(a.label, a.time) || a.day;
    if (["BOOKED", "SERVED", "CHECKED_IN", "NO_SHOW", "RESCHEDULED"].includes(a.status) && !a.bookedBy) A("INFO", `${d} booking approved (confirmed) by SSO Admin.`, new Date(a.created.getTime() + 3 * 3600000));
    if (a.status === "SERVED") { A("INFO", `${d} checked in by SSO Admin.`, new Date(slot.getTime() - 4 * 60000)); A("INFO", `${d} — ${a.stu.name} served by SSO Admin.`, new Date(slot.getTime() + 9 * 60000)); }
    if (a.status === "CHECKED_IN") A("INFO", `${d} checked in by SSO Admin.`, new Date(slot.getTime() - 3 * 60000));
    if (a.status === "NO_SHOW") A("INFO", `${d} marked as no-show by SSO Admin.`, new Date(slot.getTime() + 20 * 60000));
    if (a.status === "CANCELLED") A("INFO", `${d} cancelled by ${a.stu.name}.`, new Date(a.created.getTime() + 20 * 3600000));
  }
  for (const r of reqRows) { const h = r.history as Hist[]; h.slice(1).forEach((x, i) => A("INFO", `${r.service === "AUTHENTICATION" ? "Authentication" : r.service === "EXCUSE_SLIP" ? "Excuse Slip" : "General Visit"} request ${r.id} set to ${x.status} by SSO Admin.`, new Date((r.createdAt as Date).getTime() + (i + 1) * 5 * 3600000))); A("INFO", `${r.service === "AUTHENTICATION" ? "Authentication" : r.service === "EXCUSE_SLIP" ? "Excuse Slip" : "General Visit"} request ${r.id} submitted by ${r.name}.`, r.createdAt as Date); }
  for (const r of idRows) { const h = r.history as Hist[]; h.slice(1).forEach((x, i) => A("INFO", `ID application ${r.id} set to ${x.status} by SSO Admin.`, new Date((r.createdAt as Date).getTime() + (i + 1) * 6 * 3600000))); }
  for (const c of complaintRows) { if (c.status !== "Submitted") A("INFO", `Complaint ${c.id} set to ${c.status} by SSO Admin.`, new Date(c.createdAt.getTime() + 30 * 3600000)); if (c.confidentiality === "Strictly Confidential") A("INFO", `Confidential complaint filed (${c.category}).`, c.createdAt); }
  for (const b of bulletins) if (b.status === "Published" && b.ago > 0) A("INFO", `Bulletin "${b.title}" published by SSO Admin.`, dayAt(b.ago, 10));
  for (const f of formDefs) A("INFO", `Form "${f.title}" uploaded by SSO Admin.`, dayAt(between(28, 40), 11));
  for (const m of memos) A("INFO", `Memo "${m.subject}" blasted to ${m.recipients} student(s) by SSO Super Admin.`, dayAt(m.ago, 9));
  for (const s of students.filter((x) => x.registered).slice(9, 22)) A("INFO", `Account ${s.sn} (${s.name}) approved by SSO Super Admin.`, dayAt(between(15, 40), between(9, 15)));
  A("WARN", "Registration blocked — 2026-00099-SP-0 not in masterlist.", dayAt(8, 13));
  A("WARN", "Invalid QR signature scanned for APT-031 by Scanner Desk.", dayAt(13, 10));
  A("ERROR", "Password reset email failed for kyle.navarro@iskolarngbayan.pup.edu.ph", dayAt(5, 14));
  A("INFO", "Archive retention set to 30 days by SSO Super Admin.", dayAt(30, 15));
  A("INFO", `Complaint category "Safety & Security" updated by SSO Super Admin.`, dayAt(21, 15));

  // ───────────────────────── write everything ─────────────────────────
  // These tables are append-only logs generated relative to today, so regenerate them on every run (keeps re-seeding idempotent).
  await prisma.auditLog.deleteMany(); await prisma.notification.deleteMany(); await prisma.emailLog.deleteMany(); await prisma.slotBlock.deleteMany(); await prisma.profileChange.deleteMany();
  for (const a of appts) {
    const slotStart = parseSlotStart(a.label, a.time);
    const duration = a.service === "EVENT" ? 30 : a.service === "PSYCH" ? 45 : 10;
    const data = {
      studentId: a.stu.sn, name: a.stu.name, time: a.time, dateLabel: a.label, served: a.status === "SERVED", serviceType: a.service, serviceRefId: a.refId ?? null, organizationId: a.orgId ?? null,
      notes: "", status: a.status, dateISO: dateISOPHT(a.label), slotStartAt: slotStart, slotEndAt: slotStart ? new Date(slotStart.getTime() + duration * 60000) : null,
      cancelReason: a.cancelReason ?? null, bookedBy: a.bookedBy ?? null, rescheduleCount: a.resched ?? 0, purpose: a.purpose, copies: 1,
    };
    await prisma.queueEntry.upsert({ where: { code: a.code! }, update: data, create: { code: a.code!, ...data, createdAt: a.created } });
  }
  const J = (v: unknown) => v as never;
  await prisma.serviceRequest.createMany({ data: J(reqRows), skipDuplicates: true });
  await prisma.referral.createMany({ data: J(refRows), skipDuplicates: true });
  await prisma.eventRequest.createMany({ data: J(evtRows), skipDuplicates: true });
  await prisma.idApplication.createMany({ data: J(idRows), skipDuplicates: true });
  await prisma.complaint.createMany({ data: J(complaintRows), skipDuplicates: true });
  await prisma.ticket.deleteMany({ where: { id: { in: ticketRows.map((t) => t.id) } } });
  await prisma.ticket.createMany({ data: J(ticketRows) });
  await prisma.serviceFeedback.createMany({ data: feedbackRows, skipDuplicates: true });
  await prisma.bulletin.createMany({
    data: bulletins.map((b) => ({ id: b.id, title: b.title, category: b.category, body: b.body, featured: b.featured, status: b.status, publishAt: b.status === "Published" ? dayAt(b.ago, 8) : null, createdAt: dayAt(Math.max(b.ago, 1), 8) })),
    skipDuplicates: true,
  });
  await prisma.downloadableForm.createMany({ data: formDefs.map((f, i) => ({ id: f.id, title: f.title, cat: "General", fileName: f.file, url: `/uploads/forms/${f.file}`, createdAt: dayAt(28 + i * 3, 11) })), skipDuplicates: true });
  await prisma.memo.createMany({ data: memos.map((m) => ({ id: m.id, subject: m.subject, audienceLabel: m.audienceLabel, recipients: m.recipients, by: "SSO Super Admin", mode: "SENT", createdAt: dayAt(m.ago, 9) })), skipDuplicates: true });
  for (const [i, pc] of profileChanges.entries()) {
    const stu = byName(pc.who); const acct = accounts.get(stu.sn); if (!acct) continue;
    await prisma.profileChange.create({ data: { userId: acct.id, studentId: stu.sn, name: stu.name, email: pc.email, course: pc.course, year: pc.year, status: "Pending", createdAt: dayAt(pc.ago + i, 10) } });
  }
  await prisma.slotBlock.create({ data: { dateLabel: formatLabel(closedDay), time: null, service: null, reason: "Staff development day — SSO closed", createdBy: "SSO Super Admin" } });
  await prisma.slotBlock.create({ data: { dateLabel: formatLabel(meetingDay), time: "1:00 PM", service: null, reason: "Faculty and staff meeting", createdBy: "SSO Super Admin" } });
  for (const h of holidays.slice(0, 2)) await prisma.slotBlock.create({ data: { dateLabel: h.date, time: null, service: null, reason: `${h.name} — SSO closed`, createdBy: "SSO Super Admin" } });
  await prisma.notification.createMany({ data: notifs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) });
  await prisma.emailLog.createMany({ data: emails.map((e) => ({ ...e, error: e.status === "Failed" ? "SMTP connection timed out." : null })) });
  await prisma.auditLog.createMany({ data: audit.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()) });

  console.log(`Demo data ready: ${students.length} students (${reg.length} registered), ${appts.length} appointments, ${reqRows.length} requests, ${idRows.length} ID applications, ${refRows.length} referrals, ${evtRows.length} event requests, ${complaintRows.length} complaints, ${ticketRows.length} tickets, ${audit.length} audit entries.`);
  console.log("Logins:");
  console.log("  Student:     student@pup.edu.ph / student123  (or student number 2024-00123-SP-0)");
  console.log("  Org rep:     student number 2024-00102-SP-0 / student123 (Computer Society)");
  console.log("  Admin:       admin@pup.edu.ph / Admin@2026!");
  console.log("  Super Admin: superadmin@pup.edu.ph / SuperAdmin@2026!");
  console.log("  Scanner:     scanner@pup.edu.ph / scan2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
