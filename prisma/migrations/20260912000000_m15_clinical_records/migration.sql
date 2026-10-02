-- M-15 Clinical Records: `clinical_records`, ONE row per consultation.
--
-- A table of its own rather than columns on `consultations` because it FREEZES.
-- `finalised_at` is the moment the record becomes evidence - nothing on it may
-- change afterwards - while the consultation row goes on changing through a
-- week of follow-up. Two lifetimes cannot share one row.
--
-- `finalised_at` alone carries draft-or-final. No status column beside it, no
-- `pdf_file_id` (that is the `patient_files` row for this consultation), no
-- `referral_advised` (the written note IS the advice), and no
-- `has_clinical_doubt` (a doubt IS a `clarification_cases` row in M-17).

-- CreateEnum
CREATE TYPE "risk_category" AS ENUM ('low', 'moderate', 'high');

-- CreateTable
CREATE TABLE "clinical_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,

    "chief_complaint" TEXT NOT NULL,
    "clinical_history" TEXT,
    "diagnosis" TEXT,
    -- A provisional diagnosis is the norm in a first teleconsultation, so it is
    -- the safer of the two to state by accident.
    "is_diagnosis_provisional" BOOLEAN NOT NULL DEFAULT true,
    "risk_category" "risk_category" NOT NULL,
    -- Set = a referral was advised, and this is what for.
    "referral_note" VARCHAR(255),

    -- name, dose, frequency, duration, instructions. A jsonb array rather than
    -- a table because nothing queries ACROSS prescriptions: a line is only read
    -- as part of the record it belongs to, and it freezes with it.
    "medicines" JSONB NOT NULL DEFAULT '[]',

    -- Written by EVERY professional. Four columns rather than one blob because
    -- the patient Care Plan renders each under its own heading (FR-14.1).
    "advice_covered" TEXT,
    "advice_home_practice" TEXT,
    "advice_next_focus" TEXT,
    "advice_warning_signs" TEXT,

    "case_summary" TEXT,
    -- Ids into `content_items`, not copies: the article may be revised later
    -- and the patient should be given the current text.
    "recommended_content_ids" JSONB NOT NULL DEFAULT '[]',

    "finalised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ONE record per consultation. FR-11.6 ties booking, session metadata,
-- prescription and case summary to one consultation id; two clinical records
-- against one consultation would make "the record" ambiguous.
CREATE UNIQUE INDEX "clinical_records_consultation_id_key"
  ON "clinical_records"("consultation_id");

-- CreateIndex
CREATE INDEX "clinical_records_finalised_at_idx" ON "clinical_records"("finalised_at");

-- AddForeignKey
-- CASCADE: the clinical record has no meaning without the consultation, and an
-- erasure under SRS 6.4 must not leave the notes behind.
ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_consultation_id_fkey"
  FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** FR-11.5, AS A DATABASE RULE. ***
--
-- "A consultation is marked clinically complete only after the prescription or
-- advice is finalised and the case summary is submitted. This rule is enforced
-- by the system, not by convention." A service check is a convention - it holds
-- until someone adds a second write path. This is the rule itself.
--
-- A finalised record must carry a case summary AND a closing plan, where the
-- closing plan is either a medicine line or the advice. Which of the two is
-- acceptable depends on whether the provider's specialty may prescribe, and no
-- CHECK can see the specialty from here - so the service decides WHICH, and
-- this refuses a finalised record that has NEITHER.
ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_finalised_is_complete"
  CHECK (
    "finalised_at" IS NULL
    OR (
      "case_summary" IS NOT NULL
      AND btrim("case_summary") <> ''
      AND (
        jsonb_array_length("medicines") > 0
        OR ("advice_covered" IS NOT NULL AND btrim("advice_covered") <> '')
      )
    )
  );

-- Medicines is an ARRAY of lines. A jsonb object or scalar here would break
-- `jsonb_array_length` above, which is what the completion rule counts.
ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_medicines_is_an_array"
  CHECK (jsonb_typeof("medicines") = 'array');

ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_recommended_content_is_an_array"
  CHECK (jsonb_typeof("recommended_content_ids") = 'array');

-- A chief complaint is the one note with no useful empty state: FR-11.1 makes
-- it mandatory, and a record that does not say what the patient came with
-- cannot be read back later for anything.
ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_chief_complaint_is_written"
  CHECK (btrim("chief_complaint") <> '');

-- A referral note that is present but blank says a referral was advised while
-- saying nothing about what for, which is the exact state the missing
-- `referral_advised` flag existed to prevent.
ALTER TABLE "clinical_records"
  ADD CONSTRAINT "clinical_records_referral_note_says_something"
  CHECK ("referral_note" IS NULL OR btrim("referral_note") <> '');

-- The doctor's pending-documentation worklist (FR-9.3), and the completion gate
-- M-13 reads. A partial index because a draft is a brief state and a small
-- slice of the table, while everything else is finalised history the worklist
-- never looks at again.
CREATE INDEX "clinical_records_pending"
  ON "clinical_records" ("consultation_id")
  WHERE "finalised_at" IS NULL;
