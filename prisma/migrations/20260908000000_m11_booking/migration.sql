-- M-11 Booking: `consultations`, THE SPINE.
--
-- This migration also closes every foreign key the earlier modules deliberately
-- left open, because each of them points at a row that could not exist yet:
-- M-05's completion gate, M-10's files and report requests.

-- CreateEnum
CREATE TYPE "consultation_mode" AS ENUM ('scheduled', 'instant');

-- CreateEnum
CREATE TYPE "consultation_status" AS ENUM ('pending_payment', 'scheduled', 'awaiting_doctor', 'in_progress', 'awaiting_documentation', 'completed', 'cancelled', 'no_show', 'expired');

-- CreateEnum
CREATE TYPE "party" AS ENUM ('patient', 'doctor', 'admin', 'system');

-- CreateEnum
CREATE TYPE "followup_status" AS ENUM ('none', 'active', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "consultations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference_code" VARCHAR(24) NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_id" UUID,
    "specialty_id" UUID NOT NULL,
    "concern_id" UUID,
    "mode" "consultation_mode" NOT NULL,
    "status" "consultation_status" NOT NULL DEFAULT 'pending_payment',
    "scheduled_start_at" TIMESTAMPTZ(6),
    "duration_minutes" SMALLINT NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(6),
    "intake_answers" JSONB,
    "rescheduled_from_consultation_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_party" "party",
    "cancellation_reason" VARCHAR(200),
    "followup_pathway_id" UUID,
    "followup_starts_on" DATE,
    "followup_status" "followup_status" NOT NULL DEFAULT 'none',
    "extra_checkin_questions" JSONB NOT NULL DEFAULT '[]',
    "feedback_rating" SMALLINT,
    "feedback_comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consultations_reference_code_key" ON "consultations"("reference_code");

-- CreateIndex
CREATE INDEX "consultations_patient_id_status_idx" ON "consultations"("patient_id", "status");
CREATE INDEX "consultations_doctor_id_status_idx" ON "consultations"("doctor_id", "status");
CREATE INDEX "consultations_doctor_id_scheduled_start_at_idx" ON "consultations"("doctor_id", "scheduled_start_at");
CREATE INDEX "consultations_status_scheduled_start_at_idx" ON "consultations"("status", "scheduled_start_at");
CREATE INDEX "consultations_followup_status_followup_starts_on_idx" ON "consultations"("followup_status", "followup_starts_on");
CREATE INDEX "consultations_hold_expires_at_idx" ON "consultations"("hold_expires_at");

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION on doctor, specialty and concern: a consultation is a clinical and
-- financial record. Losing who provided it, or what service was billed, to a
-- catalogue tidy-up would be worse than refusing the tidy-up.
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_concern_id_fkey" FOREIGN KEY ("concern_id") REFERENCES "concerns"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_rescheduled_from_consultation_id_fkey" FOREIGN KEY ("rescheduled_from_consultation_id") REFERENCES "consultations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- The keys earlier modules left open, now that there is something to point at.
-- ###########################################################################

-- M-05's completion gate (FR-10.5). SET NULL: if the consultation holding a
-- provider back ever goes, the gate must OPEN, not strand them behind a row
-- that no longer exists.
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_blocked_by_consultation_id_fkey" FOREIGN KEY ("blocked_by_consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- M-10's files. NO ACTION, for the reason M-10 gives about its own uploader
-- key: a file's link to the consultation it was uploaded for is part of the
-- clinical record, not a convenience.
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- M-10's report requests. CASCADE: a request has no meaning without the
-- consultation it was raised in, which is also where its patient and doctor
-- are read from.
ALTER TABLE "report_requests" ADD CONSTRAINT "report_requests_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** WITHOUT THIS, TWO PATIENTS CAN BOOK THE SAME SLOT. ***
--
-- M-07's `assertFree` is the first lock and gives the clear refusal; this is
-- the last word. A check and a write are two statements, and two requests can
-- both pass the check before either writes - only the database can settle that.
--
-- PARTIAL, over the statuses that actually hold time. A cancelled, expired,
-- completed or no-show consultation must not block the slot: the whole point of
-- releasing an abandoned checkout is that somebody else can take it.
CREATE UNIQUE INDEX "consultations_no_double_booking"
  ON "consultations" ("doctor_id", "scheduled_start_at")
  WHERE "status" IN ('pending_payment', 'scheduled', 'awaiting_doctor', 'in_progress');

-- A consultation nobody can attend is not a booking.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_duration_is_positive" CHECK ("duration_minutes" > 0);

-- A SCHEDULED booking is a time. An instant one is not: it happens now, and
-- `scheduled_start_at` stays null until M-13 has a doctor accept it.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_scheduled_has_a_time"
  CHECK ("mode" <> 'scheduled' OR "scheduled_start_at" IS NOT NULL);

-- *** THE HOLD IS THE PENDING_PAYMENT ROW. *** There is no holds table, so the
-- expiry must exist only while the row IS a hold. A paid booking still carrying
-- one would be swept away by the very job that releases abandoned checkouts.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_hold_only_while_pending"
  CHECK ("hold_expires_at" IS NULL OR "status" = 'pending_payment');

-- Cancelled means somebody cancelled it, and says who. `expired` is the state
-- for a hold that simply ran out, which is why it is a separate status rather
-- than a cancellation with no author.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_cancelled_is_attributed"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
         AND ("cancelled_at" IS NULL) = ("cancelled_by_party" IS NULL));

-- Set = feedback submitted, so the value has to be one a patient could give.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_feedback_rating_range"
  CHECK ("feedback_rating" IS NULL OR "feedback_rating" BETWEEN 1 AND 5);

-- A consultation cannot be its own reschedule.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_reschedule_is_another_row"
  CHECK ("rescheduled_from_consultation_id" IS NULL OR "rescheduled_from_consultation_id" <> "id");

-- One generated prescription PDF per consultation (db/README item 8). M-10 owns
-- the table; the index waits for `consultations` to exist, so it lands here.
CREATE UNIQUE INDEX "patient_files_one_prescription_pdf"
  ON "patient_files" ("consultation_id")
  WHERE "file_category" = 'prescription_pdf' AND "deleted_at" IS NULL;
