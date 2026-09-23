CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "companyScopeId" TEXT NOT NULL,
    "homepageScopeId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "inquiryDate" TEXT NOT NULL,
    "inquiryTime" TEXT NOT NULL,
    "sourceStatus" TEXT,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL
);

CREATE TABLE "InquirySyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "companyScopeId" TEXT NOT NULL,
    "homepageScopeId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rangeStart" TEXT NOT NULL,
    "rangeEnd" TEXT NOT NULL,
    "startedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "completedAt" DATETIME,
    "expectedCount" INTEGER,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "errorType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "InquirySyncState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "companyScopeId" TEXT NOT NULL,
    "homepageScopeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSuccessfulAt" DATETIME,
    "lastRunId" TEXT,
    "nextRunAt" DATETIME,
    "workerHeartbeatAt" DATETIME,
    "workerOwner" TEXT,
    "workerLeaseExpiresAt" DATETIME,
    "lockOwner" TEXT,
    "lockExpiresAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Inquiry_source_companyScopeId_homepageScopeId_sourceId_key" ON "Inquiry"("source", "companyScopeId", "homepageScopeId", "sourceId");
CREATE INDEX "Inquiry_inquiryDate_inquiryTime_idx" ON "Inquiry"("inquiryDate", "inquiryTime");
CREATE INDEX "Inquiry_sourceStatus_idx" ON "Inquiry"("sourceStatus");
CREATE INDEX "InquirySyncRun_source_companyScopeId_homepageScopeId_status_createdAt_idx" ON "InquirySyncRun"("source", "companyScopeId", "homepageScopeId", "status", "createdAt");
CREATE UNIQUE INDEX "InquirySyncState_source_companyScopeId_homepageScopeId_key" ON "InquirySyncState"("source", "companyScopeId", "homepageScopeId");
