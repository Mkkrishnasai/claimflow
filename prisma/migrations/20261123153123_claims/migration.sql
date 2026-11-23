-- CreateTable
CREATE TABLE "Category" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approverId" TEXT,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "submittedAt" DATETIME,
    CONSTRAINT "Claim_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Claim_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaimLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "limitCents" INTEGER,
    CONSTRAINT "ClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClaimLine_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "Category" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "originalName" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" DATETIME NOT NULL,
    CONSTRAINT "Receipt_lineId_claimId_fkey" FOREIGN KEY ("lineId", "claimId") REFERENCES "ClaimLine" ("id", "claimId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receipt_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receipt_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaimEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "claimId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "at" DATETIME NOT NULL,
    CONSTRAINT "ClaimEvent_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClaimEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Claim_claimantId_updatedAt_idx" ON "Claim"("claimantId", "updatedAt");

-- CreateIndex
CREATE INDEX "Claim_approverId_status_idx" ON "Claim"("approverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimLine_claimId_position_key" ON "ClaimLine"("claimId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimLine_id_claimId_key" ON "ClaimLine"("id", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_storageKey_key" ON "Receipt"("storageKey");

-- CreateIndex
CREATE INDEX "Receipt_sha256_idx" ON "Receipt"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimEvent_claimId_seq_key" ON "ClaimEvent"("claimId", "seq");

-- Reference data (architecture 5.4)
INSERT INTO "Category" ("code", "label", "limitCents") VALUES
  ('travel', 'Travel', 50000),
  ('accommodation', 'Accommodation', 20000),
  ('meals', 'Meals', 5000),
  ('office_supplies', 'Office supplies', 10000),
  ('training', 'Training', 100000),
  ('other', 'Other', 10000);

-- Triggers T1..T10 (verified in CLAIM-3-S7)
CREATE TRIGGER "claim_event_no_update" BEFORE UPDATE ON "ClaimEvent" BEGIN SELECT RAISE(ABORT, 'claim_event_no_update'); END;
CREATE TRIGGER "claim_event_no_delete" BEFORE DELETE ON "ClaimEvent" BEGIN SELECT RAISE(ABORT, 'claim_event_no_delete'); END;
CREATE TRIGGER "claim_paid_no_update" BEFORE UPDATE ON "Claim" WHEN OLD."status" = 'paid' BEGIN SELECT RAISE(ABORT, 'claim_paid_no_update'); END;
CREATE TRIGGER "claim_paid_no_delete" BEFORE DELETE ON "Claim" WHEN OLD."status" = 'paid' BEGIN SELECT RAISE(ABORT, 'claim_paid_no_delete'); END;
CREATE TRIGGER "line_paid_ins" BEFORE INSERT ON "ClaimLine" WHEN (SELECT "status" FROM "Claim" WHERE "id" = NEW."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'line_paid_ins'); END;
CREATE TRIGGER "line_paid_upd" BEFORE UPDATE ON "ClaimLine" WHEN (SELECT "status" FROM "Claim" WHERE "id" = OLD."claimId") = 'paid' OR (SELECT "status" FROM "Claim" WHERE "id" = NEW."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'line_paid_upd'); END;
CREATE TRIGGER "line_paid_del" BEFORE DELETE ON "ClaimLine" WHEN (SELECT "status" FROM "Claim" WHERE "id" = OLD."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'line_paid_del'); END;
CREATE TRIGGER "receipt_paid_ins" BEFORE INSERT ON "Receipt" WHEN (SELECT "status" FROM "Claim" WHERE "id" = NEW."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'receipt_paid_ins'); END;
CREATE TRIGGER "receipt_paid_upd" BEFORE UPDATE ON "Receipt" WHEN (SELECT "status" FROM "Claim" WHERE "id" = OLD."claimId") = 'paid' OR (SELECT "status" FROM "Claim" WHERE "id" = NEW."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'receipt_paid_upd'); END;
CREATE TRIGGER "receipt_paid_del" BEFORE DELETE ON "Receipt" WHEN (SELECT "status" FROM "Claim" WHERE "id" = OLD."claimId") = 'paid' BEGIN SELECT RAISE(ABORT, 'receipt_paid_del'); END;
