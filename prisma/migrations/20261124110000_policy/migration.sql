-- AlterTable
ALTER TABLE "Claim" ADD COLUMN "secondApprovalCents" INTEGER;

-- CreateTable
CREATE TABLE "Policy" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "receiptThresholdCents" INTEGER NOT NULL,
    "secondApprovalCents" INTEGER NOT NULL
);

-- Seed the single permanent row (values in force today)
INSERT INTO "Policy" ("id", "receiptThresholdCents", "secondApprovalCents") VALUES (1, 2500, 200000);

-- Trigger T12 (FR-7): category limit stays within 1..1,000,000
CREATE TRIGGER "category_limit_bounds" BEFORE UPDATE OF "limitCents" ON "Category" WHEN NEW."limitCents" < 1 OR NEW."limitCents" > 1000000 BEGIN SELECT RAISE(ABORT, 'category_limit_bounds'); END;

-- Trigger T13 (FR-7): policy thresholds stay within 1..1,000,000
CREATE TRIGGER "policy_threshold_bounds" BEFORE UPDATE ON "Policy" WHEN NEW."receiptThresholdCents" < 1 OR NEW."receiptThresholdCents" > 1000000 OR NEW."secondApprovalCents" < 1 OR NEW."secondApprovalCents" > 1000000 BEGIN SELECT RAISE(ABORT, 'policy_threshold_bounds'); END;

-- Trigger T14 (FR-7): no second Policy row
CREATE TRIGGER "policy_no_insert" BEFORE INSERT ON "Policy" BEGIN SELECT RAISE(ABORT, 'policy_no_insert'); END;

-- Trigger T15 (FR-7): the Policy row is permanent
CREATE TRIGGER "policy_no_delete" BEFORE DELETE ON "Policy" BEGIN SELECT RAISE(ABORT, 'policy_no_delete'); END;
