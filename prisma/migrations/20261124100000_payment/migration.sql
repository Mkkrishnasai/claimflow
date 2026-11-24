-- AlterTable
ALTER TABLE "Claim" ADD COLUMN "paymentDate" TEXT;
ALTER TABLE "Claim" ADD COLUMN "paymentReference" TEXT;

-- CreateIndex
CREATE INDEX "Claim_status_updatedAt_idx" ON "Claim"("status", "updatedAt");

-- Trigger T11 (FR-6): no code path reaches paid without a payment record
CREATE TRIGGER "claim_paid_needs_payment" BEFORE UPDATE ON "Claim" WHEN NEW."status" = 'paid' AND (NEW."paymentDate" IS NULL OR NEW."paymentReference" IS NULL) BEGIN SELECT RAISE(ABORT, 'claim_paid_needs_payment'); END;
