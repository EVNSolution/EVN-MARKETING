-- Baseline for the schema that already exists in dev.db. Mark this migration
-- as applied before deploying the additive inquiry migration to that database.
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "teamId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "customerSegment" TEXT,
    "customerCategory" TEXT,
    "status" TEXT NOT NULL DEFAULT '잠재고객',
    "grade" TEXT,
    "tags" TEXT,
    "source" TEXT,
    "collectedAt" DATETIME,
    "referrer" TEXT,
    "leadType" TEXT,
    "assignee" TEXT,
    "isAgent" BOOLEAN NOT NULL DEFAULT false,
    "memo" TEXT,
    "birthYear" INTEGER,
    "regionCity" TEXT,
    "regionDist" TEXT,
    "gender" TEXT,
    "birthInfo" TEXT,
    "maritalStatus" TEXT,
    "childrenCount" INTEGER,
    "addressDetail" TEXT,
    "isSoleProprietor" BOOLEAN,
    "soleBusinessName" TEXT,
    "soleBusinessNo" TEXT,
    "soleBusinessType" TEXT,
    "b2bCategory" TEXT,
    "companyName" TEXT,
    "businessRegNo" TEXT,
    "contactTitle" TEXT,
    "industry" TEXT,
    "companyAddress" TEXT,
    "companyPhone" TEXT,
    "employeeCount" INTEGER,
    "mainContactCardUrl" TEXT,
    "contactsJson" TEXT,
    "hasVehicle" BOOLEAN,
    "vehicleMaker" TEXT,
    "vehicleName" TEXT,
    "vehiclePlateNo" TEXT,
    "vehicleYear" TEXT,
    "totalMileage" INTEGER,
    "truckType1" TEXT,
    "truckType2" TEXT,
    "truckType3" TEXT,
    "truckType4" TEXT,
    "vehicleCount" INTEGER,
    "vehicleListJson" TEXT,
    "documentsJson" TEXT,
    "b2bRevenue1" TEXT,
    "b2bRevenue2" TEXT,
    "b2bRevenue3" TEXT,
    "shipperName" TEXT,
    "cargoType" TEXT,
    "deliveryCity" TEXT,
    "deliveryDist" TEXT,
    "deliveryFreq" TEXT,
    "workShift" TEXT,
    "monthlyIncome" TEXT,
    "cargoNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "CustomerActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "content" TEXT,
    "result" TEXT,
    "nextAction" TEXT,
    "assignee" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerActivity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
