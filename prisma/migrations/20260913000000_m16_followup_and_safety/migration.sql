-- M-16 Follow-Up and Patient Safety: `followup_pathways`, `checkin_responses`
-- and `safety_alerts`.
--
-- The platform's differentiator, which is why the question sets and the
-- red-flag rules are ROWS rather than code: FR-13.7 requires an admin to change
-- them with no app release, and a rule shipped in a binary cannot be corrected
-- for a patient who is mid-follow-up.
--
-- The ASSIGNMENT of a pathway to a patient is already columns on
-- `consultations` (M-11 created them). This migration only adds the foreign key
-- that could not exist before the pathway table did.

-- CreateEnum
CREATE TYPE "checkin_status" AS ENUM ('green', 'amber', 'red');

-- Exactly FR-9.8's five. A sixth would be a screen nobody has designed.
CREATE TYPE "safety_alert_type" AS ENUM (
  'red_flag', 'amber', 'missed_checkin', 'medication_side_effect', 'followup_due'
);

-- CreateTable
CREATE TABLE "followup_pathways" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "version" SMALLINT NOT NULL DEFAULT 1,
    -- `followup_starts_on` plus this IS the end date, so nothing stores one.
    "duration_days" SMALLINT NOT NULL DEFAULT 7,
    -- The ordered question set, each option carrying the status it contributes.
    "questions" JSONB NOT NULL,
    -- FR-13.5's conditions, which force red whatever the options say.
    "red_flag_rules" JSONB NOT NULL,
    -- What a NEW assignment gets; never what an in-flight one follows.
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followup_pathways_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "checkin_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "checkin_date" DATE NOT NULL,
    "answers" JSONB NOT NULL,
    "status" "checkin_status" NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkin_responses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "safety_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alert_type" "safety_alert_type" NOT NULL,
    "consultation_id" UUID NOT NULL,
    -- Null where no single check-in produced it: a missed one, or a follow-up
    -- falling due.
    "checkin_response_id" UUID,
    -- Plain words, taken from the rule that fired. Read on a lock screen.
    "reason" VARCHAR(255),
    "acknowledged_by_admin_id" UUID,
    "acknowledged_by_doctor_id" UUID,
    -- These two timestamps ARE the status. There is no `alert_status` enum.
    "acknowledged_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "closing_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One version of a pathway per version number, so "which set was this patient
-- answering" always has exactly one answer.
CREATE UNIQUE INDEX "followup_pathways_code_version_key"
  ON "followup_pathways"("code", "version");
CREATE INDEX "followup_pathways_code_is_current_idx"
  ON "followup_pathways"("code", "is_current");

-- ONE check-in per patient per day. Two rows for one date would make "did they
-- check in" ambiguous, and a missed check-in is detected by ABSENCE.
CREATE UNIQUE INDEX "checkin_responses_consultation_id_checkin_date_key"
  ON "checkin_responses"("consultation_id", "checkin_date");
CREATE INDEX "checkin_responses_status_submitted_at_idx"
  ON "checkin_responses"("status", "submitted_at");

CREATE INDEX "safety_alerts_alert_type_created_at_idx"
  ON "safety_alerts"("alert_type", "created_at");
CREATE INDEX "safety_alerts_consultation_id_idx" ON "safety_alerts"("consultation_id");

-- AddForeignKey
-- CASCADE on the consultation: a check-in and an alert have no meaning without
-- the episode of care they belong to, and an erasure under SRS 6.4 must not
-- leave a patient's daily mood answers behind.
ALTER TABLE "checkin_responses"
  ADD CONSTRAINT "checkin_responses_consultation_id_fkey"
  FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_consultation_id_fkey"
  FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_checkin_response_id_fkey"
  FOREIGN KEY ("checkin_response_id") REFERENCES "checkin_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION, not SET NULL. An admin or doctor leaving must not erase who took
-- responsibility for a safety alert - that is the record accountability rests on.
ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_acknowledged_by_admin_id_fkey"
  FOREIGN KEY ("acknowledged_by_admin_id") REFERENCES "admins"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_acknowledged_by_doctor_id_fkey"
  FOREIGN KEY ("acknowledged_by_doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- *** THE KEY M-11 COULD NOT CREATE. ***
-- `consultations.followup_pathway_id` has existed since M-11 with nothing to
-- point at. It PINS the version the patient is answering, which is why it is
-- NO ACTION: a pathway that is still being followed cannot be deleted out from
-- under the person following it.
ALTER TABLE "consultations"
  ADD CONSTRAINT "consultations_followup_pathway_id_fkey"
  FOREIGN KEY ("followup_pathway_id") REFERENCES "followup_pathways"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** ONE CURRENT VERSION PER PATHWAY. ***
-- `is_current` decides what every NEW assignment gets. Two current versions of
-- the same pathway would make that a coin toss, and two patients seen the same
-- afternoon could be answering different clinician-approved question sets.
CREATE UNIQUE INDEX "followup_pathways_one_current_version"
  ON "followup_pathways" ("code")
  WHERE "is_current";

-- A follow-up window has to be at least a day, and a year-long daily check-in
-- is a configuration error rather than a care plan.
ALTER TABLE "followup_pathways"
  ADD CONSTRAINT "followup_pathways_duration_is_sane"
  CHECK ("duration_days" BETWEEN 1 AND 365);

-- Both jsonb columns are ARRAYS. The evaluator iterates them, and an object
-- here would make a pathway that silently grades nothing.
ALTER TABLE "followup_pathways"
  ADD CONSTRAINT "followup_pathways_questions_is_an_array"
  CHECK (jsonb_typeof("questions") = 'array');
ALTER TABLE "followup_pathways"
  ADD CONSTRAINT "followup_pathways_rules_is_an_array"
  CHECK (jsonb_typeof("red_flag_rules") = 'array');

-- A question set with no questions cannot be answered, and publishing one would
-- silently stop every patient on that pathway from checking in.
ALTER TABLE "followup_pathways"
  ADD CONSTRAINT "followup_pathways_current_has_questions"
  CHECK (NOT "is_current" OR jsonb_array_length("questions") > 0);

ALTER TABLE "checkin_responses"
  ADD CONSTRAINT "checkin_responses_answers_is_an_object"
  CHECK (jsonb_typeof("answers") = 'object');

-- *** EXACTLY ONE ACKNOWLEDGER, AND NONE WITHOUT A TIME. ***
-- Either an admin or the treating doctor takes responsibility, never both and
-- never nobody. This pair is what replaced the `alert_status` enum: an
-- acknowledged alert has a person AND a time, or it has neither.
ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_one_acknowledger"
  CHECK (num_nonnulls("acknowledged_by_admin_id", "acknowledged_by_doctor_id") <= 1);

ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_acknowledged_by_somebody"
  CHECK (
    ("acknowledged_at" IS NULL)
    = (num_nonnulls("acknowledged_by_admin_id", "acknowledged_by_doctor_id") = 0)
  );

-- An alert cannot be closed before it was acknowledged. Closing one nobody
-- looked at is exactly the outcome the two timestamps exist to prevent.
ALTER TABLE "safety_alerts"
  ADD CONSTRAINT "safety_alerts_closed_after_acknowledged"
  CHECK ("closed_at" IS NULL OR ("acknowledged_at" IS NOT NULL AND "closed_at" >= "acknowledged_at"));

-- *** THE FR-18.5 GOVERNANCE QUEUE. ***
-- Everything still open, worst first. A partial index because an open alert is
-- a brief state and a small slice of the table, while the rest is closed
-- history the queue never looks at again.
CREATE INDEX "safety_alerts_open"
  ON "safety_alerts" ("alert_type", "created_at")
  WHERE "closed_at" IS NULL;
