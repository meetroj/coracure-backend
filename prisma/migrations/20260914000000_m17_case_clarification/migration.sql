-- M-17 Case Clarification: `clarification_cases`, one row per case.
--
-- Lets a treating doctor get an expert opinion WITHOUT exposing the patient.
-- The de-identification is structural rather than procedural: there is nowhere
-- in this table to put a name, a phone number, an address or an email, and
-- M-10's existing CHECK forbids a case attachment from carrying a patient.
--
-- This migration also closes the foreign key M-10 left open. `patient_files`
-- has carried `clarification_case_id` since then with nothing to point at.

-- CreateEnum
-- FR-12.6's seven, in the order a case moves through them.
CREATE TYPE "clarification_status" AS ENUM (
  'draft', 'posted', 'awaiting_response', 'response_received',
  'clarification_asked', 'reviewed', 'closed'
);

-- Drives the expert queue. Never a clinical severity - that is the case text.
CREATE TYPE "clarification_urgency" AS ENUM ('routine', 'soon', 'urgent');

-- CreateTable
CREATE TABLE "clarification_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "treating_doctor_id" UUID NOT NULL,
    -- NEVER exposed to the reviewer. For the treating doctor and audit only.
    "source_consultation_id" UUID,

    -- The de-identified snapshot (FR-12.3). Age and gender are the only patient
    -- attributes here, and neither identifies anybody on its own.
    "title" VARCHAR(200) NOT NULL,
    "patient_age" SMALLINT,
    "patient_gender" "gender",
    "brief_history" TEXT NOT NULL,
    "diagnosis" TEXT,
    "current_plan" TEXT,
    "specific_doubt" TEXT NOT NULL,
    "urgency" "clarification_urgency" NOT NULL DEFAULT 'routine',

    -- The ONE expert who may see this case.
    "expert_doctor_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),

    "messages" JSONB NOT NULL DEFAULT '[]',

    "status" "clarification_status" NOT NULL DEFAULT 'draft',
    "posted_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clarification_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clarification_cases_treating_doctor_id_status_idx"
  ON "clarification_cases"("treating_doctor_id", "status");
-- The expert's own list. FR-12.4: they see what is assigned to them, nothing else.
CREATE INDEX "clarification_cases_expert_doctor_id_status_idx"
  ON "clarification_cases"("expert_doctor_id", "status");
-- The admin's assignment queue, worst-waiting first.
CREATE INDEX "clarification_cases_status_urgency_idx"
  ON "clarification_cases"("status", "urgency");

-- AddForeignKey
-- NO ACTION on both doctors: a case is the record of a clinical question that
-- was asked and answered, and neither party leaving may erase it.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_treating_doctor_id_fkey"
  FOREIGN KEY ("treating_doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_expert_doctor_id_fkey"
  FOREIGN KEY ("expert_doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- SET NULL, unlike the doctors. If the consultation is erased under SRS 6.4 the
-- case must survive WITHOUT its one link back to a patient - which leaves it in
-- exactly the de-identified state a reviewer always saw.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_source_consultation_id_fkey"
  FOREIGN KEY ("source_consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- *** THE KEY M-10 COULD NOT CREATE. ***
-- `patient_files.clarification_case_id` has existed since M-10 with nothing to
-- point at. CASCADE: an attachment has no meaning without its case, and M-10's
-- CHECK already guarantees such a row carries no patient to orphan.
ALTER TABLE "patient_files"
  ADD CONSTRAINT "patient_files_clarification_case_id_fkey"
  FOREIGN KEY ("clarification_case_id") REFERENCES "clarification_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** AN ASSIGNMENT IS AN EXPERT AND A TIME, OR IT IS NEITHER. ***
-- `assigned_at` drives the expert's queue. A time with nobody assigned would
-- put a case in a queue no expert can see; an expert with no time would leave
-- it unsorted at the bottom of one.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_assignment_is_whole"
  CHECK (("expert_doctor_id" IS NULL) = ("assigned_at" IS NULL));

-- *** A CASE CANNOT BE WITH AN EXPERT WITHOUT ONE. ***
-- Every status past `posted` means an expert is involved, so an unassigned case
-- must not be able to reach one. This is what keeps the queue honest.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_expert_states_need_an_expert"
  CHECK (
    "status" IN ('draft', 'posted', 'closed')
    OR "expert_doctor_id" IS NOT NULL
  );

-- A doctor cannot be their own expert. The whole point is a second opinion, and
-- a case assigned back to its author is one that will never get one.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_expert_is_somebody_else"
  CHECK ("expert_doctor_id" IS NULL OR "expert_doctor_id" <> "treating_doctor_id");

-- A draft has not been posted; everything past draft has. The timestamp IS the
-- fact, so it cannot disagree with the status beside it.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_posted_when_out_of_draft"
  CHECK (("status" = 'draft') = ("posted_at" IS NULL));

-- `closed_at` set means closed, and closed means `closed_at` set.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_closed_when_closed"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));

-- The thread is an ARRAY. The service appends to it atomically with `||`, which
-- silently does the wrong thing on an object.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_messages_is_an_array"
  CHECK (jsonb_typeof("messages") = 'array');

-- An age that is not a human age is a typo, and a de-identified case is exactly
-- where a typo goes unnoticed - there is no name beside it to look wrong.
ALTER TABLE "clarification_cases"
  ADD CONSTRAINT "clarification_cases_age_is_plausible"
  CHECK ("patient_age" IS NULL OR "patient_age" BETWEEN 0 AND 120);

-- The admin's assignment queue: posted, unassigned, urgent first. A partial
-- index because waiting-to-be-assigned is a brief state and a small slice.
CREATE INDEX "clarification_cases_awaiting_assignment"
  ON "clarification_cases" ("urgency", "posted_at")
  WHERE "status" = 'posted';

-- The expert's own open work: everything assigned to them and not yet closed.
CREATE INDEX "clarification_cases_expert_open"
  ON "clarification_cases" ("expert_doctor_id", "urgency", "assigned_at")
  WHERE "closed_at" IS NULL;
