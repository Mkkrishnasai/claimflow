-- AlterTable
ALTER TABLE "ClaimLine" ADD COLUMN "justification" TEXT;
ALTER TABLE "ClaimLine" ADD COLUMN "duplicateClaimId" TEXT;
ALTER TABLE "ClaimLine" ADD COLUMN "duplicateBasis" TEXT;

-- CreateIndex
CREATE INDEX "ClaimLine_date_categoryCode_amountCents_idx" ON "ClaimLine"("date", "categoryCode", "amountCents");
