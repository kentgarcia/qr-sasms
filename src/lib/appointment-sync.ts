import type { Prisma as PrismaTypes } from "@prisma/client";
import { prisma } from "./prisma";
import { serviceLabel } from "./appointments";
import { addNotification, notifyStudentByEmail } from "./notify";
import { pushRequestHistory } from "./service-requests";
import { fnow } from "./format";

export type QueueSyncRow = {
  code: string;
  studentId: string;
  name: string;
  serviceType: string;
  serviceRefId: string | null;
  dateLabel: string;
  time: string;
};

/**
 * Mirror a visit event onto the linked request record. Never throws —
 * the appointment transition must not fail because of propagation.
 */
export async function propagateToLinked(entry: QueueSyncRow, visitStatus: string, by: string) {
  if (!entry.serviceRefId) return;
  try {
    if (entry.serviceType === "GENERAL" || entry.serviceType === "AUTH" || entry.serviceType === "EXCUSE") {
      const linked = await prisma.serviceRequest.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const isPickup = entry.serviceType === "AUTH" || entry.serviceType === "EXCUSE";
      if (visitStatus === "Completed") {
        if (["Completed", "Cancelled", "No Show", "Rejected"].includes(linked.status)) return;
        const history = pushRequestHistory(linked.history, {
          status: "Completed",
          by,
          note: isPickup ? `Pickup ${entry.code} completed` : `Visit ${entry.code} served`,
        });
        await prisma.serviceRequest.update({
          where: { id: linked.id },
          data: { status: "Completed", ...(isPickup ? { pickedUpAt: new Date() } : {}), history },
        });
        await notifyStudentByEmail({
          studentId: linked.sn,
          name: linked.name,
          title: `${serviceLabel(entry.serviceType)} — Completed`,
          message: `Your ${serviceLabel(entry.serviceType)} (${linked.id}, appointment ${entry.code}) has been completed. Thank you!`,
          ref: linked.id,
        });
        await addNotification(
          linked.sn,
          `${serviceLabel(entry.serviceType)} Completed`,
          `Your ${serviceLabel(entry.serviceType)} (${linked.id}) is now: Completed.`
        );
      } else if (visitStatus === "Approved" && !isPickup) {
        const nextStatus = ["Pending Review", "Pending"].includes(linked.status) ? "Confirmed" : linked.status;
        const history = pushRequestHistory(linked.history, { status: nextStatus, by, note: `Appointment ${entry.code}: Confirmed` });
        await prisma.serviceRequest.update({
          where: { id: linked.id },
          data: { status: nextStatus, appointmentCode: entry.code, dateLabel: entry.dateLabel, time: entry.time, history },
        });
      } else if (visitStatus === "Checked In" && !isPickup) {
        const history = pushRequestHistory(linked.history, { status: "Checked In", by, note: `Appointment ${entry.code}: Checked In` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { status: "Checked In", history } });
      } else if (visitStatus === "No Show") {
        if (["Completed", "Cancelled", "No Show", "Rejected"].includes(linked.status)) return;
        const nextStatus = isPickup ? "Ready for Pickup" : "No Show";
        const history = pushRequestHistory(linked.history, { status: nextStatus, by, note: `Missed appointment ${entry.code}` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { status: nextStatus, history } });
      } else if (visitStatus === "Cancelled" || visitStatus === "Rejected") {
        const nextStatus = isPickup ? "Ready for Pickup" : visitStatus;
        const history = pushRequestHistory(linked.history, { status: nextStatus, by, note: `Appointment ${entry.code}: ${visitStatus}` });
        await prisma.serviceRequest.update({
          where: { id: linked.id },
          data: { status: nextStatus, appointmentCode: null, history },
        });
      } else {
        const history = pushRequestHistory(linked.history, { status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
        await prisma.serviceRequest.update({ where: { id: linked.id }, data: { history } });
      }
      return;
    }
    if (entry.serviceType === "EVENT") {
      const linked = await prisma.eventRequest.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const history = Array.isArray(linked.history) ? ([...linked.history] as PrismaTypes.JsonArray) : [];
      history.push({ ts: fnow(), status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      const clearLink = visitStatus === "Cancelled" || visitStatus === "Rejected";
      await prisma.eventRequest.update({
        where: { id: linked.id },
        data: {
          history,
          ...(clearLink
            ? { appointmentCode: null, appointmentDate: "", appointmentTime: "" }
            : { appointmentCode: entry.code, appointmentDate: entry.dateLabel, appointmentTime: entry.time }),
        },
      });
      return;
    }
    if (entry.serviceType === "PSYCH") {
      const linked = await prisma.referral.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      const history = Array.isArray(linked.history) ? ([...linked.history] as PrismaTypes.JsonArray) : [];
      history.push({ ts: fnow(), status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      const clearLink = visitStatus === "Cancelled" || visitStatus === "Rejected";
      await prisma.referral.update({
        where: { id: linked.id },
        data: {
          history,
          ...(clearLink
            ? { appointmentCode: null, appointmentDate: "", appointmentTime: "" }
            : { appointmentCode: entry.code, appointmentDate: entry.dateLabel, appointmentTime: entry.time }),
        },
      });
      return;
    }
    if (entry.serviceType === "ID_NEW" || entry.serviceType === "ID_LOST") {
      const linked = await prisma.idApplication.findUnique({ where: { id: entry.serviceRefId } });
      if (!linked) return;
      if (visitStatus === "Completed") {
        if (!["Claimed", "Completed", "Rejected", "Cancelled"].includes(linked.status)) {
          const history = pushRequestHistory(linked.history, { status: "Claimed", by, note: `Pickup ${entry.code} completed` });
          await prisma.idApplication.update({
            where: { id: linked.id },
            data: { status: "Claimed", pickedUpAt: new Date(), history },
          });
          await notifyStudentByEmail({
            studentId: linked.sn,
            name: linked.name,
            title: "Student ID — Claimed",
            message: `Your ${linked.type} application (${linked.id}) has been completed. Thank you!`,
            ref: linked.id,
          });
          await addNotification(linked.sn, "ID Application Claimed", `Your ${linked.type} (${linked.id}) is now: Claimed.`);
        }
        return;
      }
      const history = pushRequestHistory(linked.history, { status: linked.status, by, note: `Appointment ${entry.code}: ${visitStatus}` });
      await prisma.idApplication.update({ where: { id: linked.id }, data: { history } });
    }
  } catch {
    // Propagation is best-effort; the appointment transition already succeeded.
  }
}
