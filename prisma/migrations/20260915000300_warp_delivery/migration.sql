ALTER TABLE "Inquiry" ADD COLUMN "warpCustomerId" TEXT;
ALTER TABLE "Inquiry" ADD COLUMN "warpActivityId" TEXT;
ALTER TABLE "Inquiry" ADD COLUMN "warpDeliveredAt" DATETIME;
ALTER TABLE "Inquiry" ADD COLUMN "warpAttemptedAt" DATETIME;
ALTER TABLE "Inquiry" ADD COLUMN "warpError" TEXT;
CREATE INDEX "Inquiry_warpDeliveredAt_warpAttemptedAt_idx" ON "Inquiry"("warpDeliveredAt", "warpAttemptedAt");
