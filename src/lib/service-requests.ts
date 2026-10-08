import type { Prisma } from "@prisma/client";
import { fnow } from "./format";

/**
 * Shared lifecycle for request-based services (spec §§2,5,7).
 *
 * Minimal flow (all services):
 *   Pending Review → Approved → Ready for Pickup → Pickup Scheduled → Completed
 * Alternative paths: Pending Review → Needs Revision → Pending Review,
 *   Pending Review → Rejected, any open state → Cancelled.
 * General Visit appointments carry the visit itself (Pending Approval →
 * Booked → Checked In → …); the request only tracks review + completion.
 */

export const SERVICE_REQUEST_SERVICES: Record<
  string,
  { label: string; prefix: string; pickup: boolean; appointment: boolean }
> = {
  AUTHENTICATION: { label: "Authentication", prefix: "AUT", pickup: true, appointment: false },
  EXCUSE_SLIP: { label: "Excuse Slip", prefix: "EXC", pickup: true, appointment: false },
  GENERAL_VISIT: { label: "General Visit", prefix: "GEN", pickup: false, appointment: true },
};

export function isKnownRequestService(service: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_REQUEST_SERVICES, service);
}

export function requestServiceLabel(service: string): string {
  return SERVICE_REQUEST_SERVICES[service]?.label || service;
}

export const TERMINAL_REQUEST_STATUSES = ["Rejected", "Completed", "Cancelled", "No Show", "Claimed"];

/** Statuses that close a request (it can no longer be used or edited). */
export function isClosedRequestStatus(status: string): boolean {
  return /^(rejected|cancelled|disapproved|closed|resolved|completed|claimed|no.?show)$/i.test(
    (status || "").trim()
  );
}

/**
 * Allowed admin transitions. `from` values not listed here are legacy
 * states from the old extended vocabulary (Under Review, Processing,
 * Confirmed, Checked In, In Progress, No Show, Pending) and may move to
 * any minimal state.
 */
const REQUEST_TRANSITIONS: Record<string, string[]> = {
  "Pending Review": ["Approved", "Needs Revision", "Rejected"],
  "Needs Revision": ["Approved", "Rejected", "Pending Review"],
  Approved: ["Ready for Pickup", "Pickup Scheduled", "Completed", "Cancelled"],
  "Ready for Pickup": ["Pickup Scheduled", "Cancelled"],
  "Pickup Scheduled": ["Completed", "Cancelled"],
};

export function allowedRequestTransitions(from: string): string[] {
  if (Object.prototype.hasOwnProperty.call(REQUEST_TRANSITIONS, from)) {
    return REQUEST_TRANSITIONS[from];
  }
  // Legacy / unknown states: allow moving into the minimal flow.
  return ["Approved", "Needs Revision", "Rejected", "Ready for Pickup", "Pickup Scheduled", "Completed", "Cancelled"];
}

export function canTransitionRequest(from: string, to: string): boolean {
  if (from === to) return true;
  if (TERMINAL_REQUEST_STATUSES.includes(from)) return false;
  return allowedRequestTransitions(from).includes(to);
}

/** Append a history entry to a Json history column. */
export function pushRequestHistory(
  existing: unknown,
  entry: { status: string; by: string; note?: string }
): Prisma.JsonArray {
  const history: Prisma.JsonArray = Array.isArray(existing)
    ? ([...existing] as Prisma.JsonArray)
    : [];
  history.push({ ts: fnow(), ...entry });
  return history;
}

// ── Per-module admin status vocabularies (imported by routes; Next.js route
// modules may only export HTTP handlers, so the lists live here) ──

export const ID_STATUSES = [
  "Pending",
  "OR Verified",
  "Needs Revision",
  "Approved",
  "Processing",
  "Ready for Claiming",
  "Claimed",
  "Completed",
  "Rejected",
  "Cancelled",
];

export const REFERRAL_STATUSES = [
  "Pending",
  "Under Review",
  "Needs Revision",
  "Approved",
  "Confirmed",
  "Checked In",
  "In Progress",
  "Completed",
  "Rejected",
  "Cancelled",
  "No Show",
];

export const EVENT_STATUSES = [
  "Pending",
  "Under Review",
  "Needs Revision",
  "Approved",
  "Confirmed",
  "Checked In",
  "In Progress",
  "Completed",
  "Rejected",
  "Cancelled",
  "No Show",
];
