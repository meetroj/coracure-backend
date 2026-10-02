-- M-12 Payments and Billing: one row per consultation, carrying the frozen
-- bill, the refund and the payout.
--
-- There is no gateway events table. Replay safety is the unique
-- `gateway_payment_id` and `gateway_refund_id` below, with raw payloads written
-- to the audit log.

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('created', 'pending', 'paid', 'failed', 'refunded');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "consultation_fee" DECIMAL(10,2) NOT NULL,
    "convenience_fee_pct" DECIMAL(5,2) NOT NULL,
    "convenience_fee" DECIMAL(10,2) NOT NULL,
    "gst_pct" DECIMAL(5,2) NOT NULL,
    "gst_amount" DECIMAL(10,2) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'created',
    "gateway_order_id" VARCHAR(120),
    "gateway_payment_id" VARCHAR(120),
    "payment_method" VARCHAR(40),
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(200),
    "refund_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "refund_reason" VARCHAR(200),
    "refund_initiated_by_admin_id" UUID,
    "gateway_refund_id" VARCHAR(120),
    "refunded_at" TIMESTAMPTZ(6),
    "payout_paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ONE bill per consultation. Two would mean a patient could be charged twice
-- for one appointment and neither row would be wrong on its own.
CREATE UNIQUE INDEX "payments_consultation_id_key" ON "payments"("consultation_id");

-- CreateIndex
-- *** THE IDEMPOTENCY KEYS. *** A gateway retries a webhook until it is
-- acknowledged, so the same capture arrives more than once as a matter of
-- course. These are what make the second delivery a no-op instead of a second
-- payment or a second refund.
CREATE UNIQUE INDEX "payments_gateway_order_id_key" ON "payments"("gateway_order_id");
CREATE UNIQUE INDEX "payments_gateway_payment_id_key" ON "payments"("gateway_payment_id");
CREATE UNIQUE INDEX "payments_gateway_refund_id_key" ON "payments"("gateway_refund_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- AddForeignKey
-- NO ACTION on the consultation: a payment is a financial record and must
-- outlive any tidy-up of the appointment it belongs to.
ALTER TABLE "payments" ADD CONSTRAINT "payments_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_initiated_by_admin_id_fkey" FOREIGN KEY ("refund_initiated_by_admin_id") REFERENCES "admins"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** A REFUND CAN NEVER EXCEED WHAT WAS CHARGED. *** The charged total is not
-- stored - it is the sum of the three - so the check adds them up rather than
-- trusting a fourth column that could disagree with its own parts.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_within_charge"
  CHECK ("refund_amount" <= "consultation_fee" + "convenience_fee" + "gst_amount");

-- Money is never negative, and neither is a rate.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amounts_not_negative"
  CHECK ("consultation_fee" >= 0 AND "convenience_fee" >= 0 AND "gst_amount" >= 0
         AND "refund_amount" >= 0 AND "convenience_fee_pct" >= 0 AND "gst_pct" >= 0);

-- *** PAID MEANS THE GATEWAY SAID SO. *** `paid_at` and the gateway's payment
-- id arrive together on the webhook, and a `paid` row missing either is one
-- that was marked paid by something other than a verified webhook (FR-7.6).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_paid_is_evidenced"
  CHECK (("status" IN ('paid', 'refunded')) = ("paid_at" IS NOT NULL AND "gateway_payment_id" IS NOT NULL));

-- A refund is money returned, so it says who asked for it and when. Nothing
-- refunds itself.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_is_attributed"
  CHECK (("refund_amount" > 0) = ("refunded_at" IS NOT NULL AND "refund_initiated_by_admin_id" IS NOT NULL));

-- Nothing is refunded that was never captured, and nothing is paid out on a
-- consultation nobody paid for.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_needs_a_payment"
  CHECK ("refund_amount" = 0 OR "paid_at" IS NOT NULL);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_payout_needs_a_payment"
  CHECK ("payout_paid_at" IS NULL OR "paid_at" IS NOT NULL);

-- The unpaid-payout queue (db/README item 9). A partial index, because the
-- queue is "paid but not yet paid out" and that is a small slice of the table.
CREATE INDEX "payments_payout_pending"
  ON "payments" ("paid_at")
  WHERE "payout_paid_at" IS NULL AND "status" = 'paid';
