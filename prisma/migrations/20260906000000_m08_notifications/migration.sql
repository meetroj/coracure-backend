-- M-08 Notifications: one row per recipient, with the copy as it was sent.
-- The templates behind these rows are an `app_config` value, not a table, so
-- changing what a reminder says is an admin action and never a release.

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('queued', 'sent', 'failed');

-- CreateTable
CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "patient_id" UUID,
    "doctor_id" UUID,
    "admin_id" UUID,
    "template_code" VARCHAR(80) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "deep_link_data" JSONB,
    "consultation_id" UUID,
    "status" "notification_status" NOT NULL DEFAULT 'queued',
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "failure_reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_patient_id_created_at_idx" ON "notifications"("patient_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_doctor_id_created_at_idx" ON "notifications"("doctor_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_admin_id_created_at_idx" ON "notifications"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- AddForeignKey
-- CASCADE on all three: a notification is addressed to one account and means
-- nothing without it. This is the opposite of `audit_log`, which carries no key
-- at all precisely because an audit entry MUST outlive what it describes.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** EXACTLY ONE RECIPIENT ***  Three nullable columns would otherwise allow
-- a row addressed to nobody, which no inbox query would ever return, and a row
-- addressed to a patient AND a doctor, which would show one person's alert to
-- another. Both are silent: neither errors anywhere without this.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_exactly_one_recipient"
  CHECK (num_nonnulls("patient_id", "doctor_id", "admin_id") = 1);

-- A failed delivery says why, and a delivery that did not fail does not.
-- Without this, `failed` with no reason is an operator staring at a dead row
-- with nothing to act on.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_failure_has_a_reason"
  CHECK (("status" = 'failed') = ("failure_reason" IS NOT NULL));

-- `sent_at` is set when, and only when, the row reached `sent`. A sent row with
-- no timestamp cannot be aged out, and an unsent row with one is a lie.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_sent_has_a_time"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

-- Read before it was ever delivered is not a state that exists.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_read_implies_sent"
  CHECK ("read_at" IS NULL OR "sent_at" IS NOT NULL);
