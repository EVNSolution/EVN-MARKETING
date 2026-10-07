CREATE TABLE "LandingReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inquiryId" TEXT,
    "fingerprint" TEXT,
    "kind" TEXT,
    "region" TEXT,
    "consentVersion" TEXT,
    "consentedAt" DATETIME,
    "closedAt" DATETIME,
    CONSTRAINT "LandingReceipt_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LandingReceipt_inquiryId_key" ON "LandingReceipt"("inquiryId");
CREATE TABLE "LandingThrottle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "windowStart" DATETIME NOT NULL,
    "count" INTEGER NOT NULL
);
CREATE INDEX "LandingThrottle_windowStart_idx" ON "LandingThrottle"("windowStart");
