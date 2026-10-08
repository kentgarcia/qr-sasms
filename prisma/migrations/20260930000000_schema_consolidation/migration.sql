-- Consolidate schema drift: tables and columns that were applied to live
-- databases via `prisma db push` over time but never captured in a migration
-- (ServiceRequest, Organization + representatives, SystemSetting,
-- MasterlistGroup, ProfileChange, ServiceFeedback, ReminderLog, UploadedFile,
-- plus appointment-link / pickup-leg / registry columns and their indexes).
-- Generated with `prisma migrate diff --from-migrations ... --to-schema-datamodel ...`
-- with one hand-edit: the Role enum addition is wrapped in a DO block so the
-- migration also applies cleanly to databases that already received the value
-- via `db push` (dev, staging, Render prod).
-- Purely additive: no drops, no data rewrites, safe to deploy anywhere.

-- AlterEnum (idempotent form of: ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN')
DO $$
BEGIN
  BEGIN
    ALTER TYPE "Role" ADD VALUE 'SUPER_ADMIN';
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "assignedTo" TEXT,
ADD COLUMN     "confidentiality" TEXT NOT NULL DEFAULT 'Standard',
ADD COLUMN     "staffNotes" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "EventRequest" ADD COLUMN     "appointmentCode" TEXT,
ADD COLUMN     "appointmentDate" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "appointmentTime" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "organizationId" TEXT;

-- AlterTable
ALTER TABLE "IdApplication" ADD COLUMN     "affidavitName" TEXT,
ADD COLUMN     "affidavitUrl" TEXT,
ADD COLUMN     "history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "pickupDate" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pickupNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "pickupTime" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "MasterlistEntry" ADD COLUMN     "course" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "schoolYear" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "year" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "appointmentCode" TEXT,
ADD COLUMN     "appointmentDate" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "appointmentTime" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiry" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MasterlistGroup" (
    "id" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL,
    "course" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterlistGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRequest" (
    "id" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "copies" INTEGER NOT NULL DEFAULT 1,
    "docName" TEXT NOT NULL DEFAULT '',
    "docUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending Review',
    "remarks" TEXT NOT NULL DEFAULT '',
    "history" JSONB NOT NULL DEFAULT '[]',
    "appointmentCode" TEXT,
    "dateLabel" TEXT NOT NULL DEFAULT '',
    "time" TEXT NOT NULL DEFAULT '',
    "slotStartAt" TIMESTAMP(3),
    "pickupDate" TEXT NOT NULL DEFAULT '',
    "pickupTime" TEXT NOT NULL DEFAULT '',
    "pickupNote" TEXT NOT NULL DEFAULT '',
    "pickedUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adviserName" TEXT NOT NULL,
    "schoolYear" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationRepresentative" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationRepresentative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ProfileChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "course" TEXT,
    "year" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceFeedback" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "reminderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MasterlistGroup_schoolYear_course_year_key" ON "MasterlistGroup"("schoolYear", "course", "year");

-- CreateIndex
CREATE INDEX "ServiceRequest_sn_idx" ON "ServiceRequest"("sn");

-- CreateIndex
CREATE INDEX "ServiceRequest_service_status_idx" ON "ServiceRequest"("service", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_storedName_key" ON "UploadedFile"("storedName");

-- CreateIndex
CREATE INDEX "UploadedFile_uploadedBy_idx" ON "UploadedFile"("uploadedBy");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_name_key" ON "Organization"("name");

-- CreateIndex
CREATE INDEX "OrganizationRepresentative_studentId_active_idx" ON "OrganizationRepresentative"("studentId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationRepresentative_organizationId_studentId_key" ON "OrganizationRepresentative"("organizationId", "studentId");

-- CreateIndex
CREATE INDEX "ProfileChange_userId_idx" ON "ProfileChange"("userId");

-- CreateIndex
CREATE INDEX "ProfileChange_status_idx" ON "ProfileChange"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceFeedback_requestId_key" ON "ServiceFeedback"("requestId");

-- CreateIndex
CREATE INDEX "ServiceFeedback_studentId_idx" ON "ServiceFeedback"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_reminderKey_key" ON "ReminderLog"("reminderKey");

-- CreateIndex
CREATE INDEX "EventRequest_organizationId_date_idx" ON "EventRequest"("organizationId", "date");

-- CreateIndex
CREATE INDEX "IdApplication_status_idx" ON "IdApplication"("status");

-- CreateIndex
CREATE INDEX "QueueEntry_dateLabel_time_idx" ON "QueueEntry"("dateLabel", "time");

-- AddForeignKey
ALTER TABLE "OrganizationRepresentative" ADD CONSTRAINT "OrganizationRepresentative_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
