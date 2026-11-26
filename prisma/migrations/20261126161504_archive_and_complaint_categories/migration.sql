-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EventRequest" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "IdApplication" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QueueEntry" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ServiceRequest" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ComplaintCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplaintCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComplaintCategory_name_key" ON "ComplaintCategory"("name");

-- CreateIndex
CREATE INDEX "Complaint_archivedAt_idx" ON "Complaint"("archivedAt");

-- CreateIndex
CREATE INDEX "EventRequest_archivedAt_idx" ON "EventRequest"("archivedAt");

-- CreateIndex
CREATE INDEX "IdApplication_archivedAt_idx" ON "IdApplication"("archivedAt");

-- CreateIndex
CREATE INDEX "QueueEntry_archivedAt_idx" ON "QueueEntry"("archivedAt");

-- CreateIndex
CREATE INDEX "Referral_archivedAt_idx" ON "Referral"("archivedAt");

-- CreateIndex
CREATE INDEX "ServiceRequest_archivedAt_idx" ON "ServiceRequest"("archivedAt");

-- CreateIndex
CREATE INDEX "Ticket_archivedAt_idx" ON "Ticket"("archivedAt");
