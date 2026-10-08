import { NextResponse } from "next/server";
import { requireSession } from "@/lib/http";

const HEADERS = ["sn", "name", "email", "course", "year", "schoolYear"] as const;

const EXAMPLE_ROWS = [
  ["2024-00001-SP-0", "Juan D. Cruz", "juancruz@example.com", "BSIT", "1st Year", "2026-2027"],
  ["2024-00002-SP-0", "Maria S. Santos", "mariasantos@example.com", "BSCS", "2nd Year", "2026-2027"],
];

function toCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Downloadable fill-in sheet for Masterlist Manager bulk-add.
 * Super-admin only. Returns a CSV with the exact headers the
 * bulk-add preview expects, plus example rows.
 */
export async function GET() {
  const auth = await requireSession(["super_admin"]);
  if (auth instanceof NextResponse) return auth;

  const lines = [
    HEADERS.join(","),
    ...EXAMPLE_ROWS.map((r) => r.map(toCsvCell).join(",")),
  ];
  const csv = lines.join("\n") + "\n";

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="masterlist-template.csv"',
    },
  });
}
