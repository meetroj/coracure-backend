-- M-19 Feedback and Complaints: `complaints`, with the message thread on the row.
--
-- Post-consult FEEDBACK gets no table. It is `feedback_rating` and
-- `feedback_comment` on `consultations`, which M-11 created and this module
-- writes: a rating is an attribute of that appointment, not a record with a
-- life of its own. It has no workflow, no thread and no assignee.
--
-- A COMPLAINT is the opposite - four states, an assignee, a conversation and an
-- outcome somebody has to stand behind - which is why it is a table.

-- CreateEnum
-- FR-18.8's workflow. `rejected` is NOT `resolved`: "we looked and disagreed"
-- is a different outcome from "we fixed it", and a patient is owed the
-- distinction.
CREATE TYPE "complaint_status" AS ENUM ('open', 'in_progress', 'resolved', 'rejected');

CREATE TYPE "complaint_category" AS ENUM (
  'consultation_quality', 'doctor_conduct', 'technical_issue', 'payment_issue', 'other'
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- The ticket number the patient quotes to support. `CX-` rather than a
    -- consultation's `CC-`, so somebody reading a code down a phone line knows
    -- which of the two they have been handed.
    "reference_code" VARCHAR(24) NOT NULL,
    "patient_id" UUID NOT NULL,
    -- Null when the complaint is not about one consultation: a billing problem,
    -- or the app itself.
    "consultation_id" UUID,
    "category" "complaint_category" NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "complaint_status" NOT NULL DEFAULT 'open',
    -- Null means nobody has picked it up, which is exactly the unassigned queue.
    "assigned_to_admin_id" UUID,
    -- Each entry carries `isInternal`, so an admin can think out loud on the
    -- ticket without the patient reading it - and the patient view filters on
    -- that one flag rather than on a second table that would interleave badly.
    "messages" JSONB NOT NULL DEFAULT '[]',
    -- Set ONLY when resolved. A rejected complaint has an outcome but not a
    -- resolution, and conflating them makes "how many did we resolve"
    -- unanswerable for FR-18.6.
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complaints_reference_code_key" ON "complaints"("reference_code");
-- The admin queue: oldest first within a state.
CREATE INDEX "complaints_status_created_at_idx" ON "complaints"("status", "created_at");
-- "My complaints", for the patient tracking theirs (FR-17.2).
CREATE INDEX "complaints_patient_id_idx" ON "complaints"("patient_id");

-- AddForeignKey
-- CASCADE on the patient: an erasure under SRS 6.4 takes their complaints with
-- it, because a complaint is written in the patient's own words about their own
-- care and is theirs.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_patient_id_fkey"
  FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION on the consultation, unlike the patient. A complaint about a
-- consultation must not disappear because the consultation was tidied away - it
-- is frequently the evidence behind a refund.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_consultation_id_fkey"
  FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- NO ACTION: an admin leaving must not erase who was handling a complaint.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_assigned_to_admin_id_fkey"
  FOREIGN KEY ("assigned_to_admin_id") REFERENCES "admins"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** RESOLVED MEANS RESOLVED. ***
-- `resolved_at` is set exactly when the status is `resolved` - never for a
-- rejection, and never absent from a resolution. FR-18.6 counts resolutions,
-- and a timestamp that could drift from the status would make that count a
-- guess.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_resolved_at_matches_status"
  CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL));

-- *** A TERMINAL DECISION IS EXPLAINED. ***
-- Both endings need a note. A patient told only "rejected" has been dismissed
-- rather than answered, and the note is what a later escalation is read against.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_ending_is_explained"
  CHECK (
    "status" NOT IN ('resolved', 'rejected')
    OR ("resolution_note" IS NOT NULL AND length(btrim("resolution_note")) > 0)
  );

-- Nobody closes a complaint that was never picked up. Somebody has to own the
-- decision, and `assigned_to_admin_id` is who.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_ending_has_an_owner"
  CHECK ("status" NOT IN ('resolved', 'rejected') OR "assigned_to_admin_id" IS NOT NULL);

-- The thread is an ARRAY. The service appends with `||`, which silently does
-- the wrong thing on an object.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_messages_is_an_array"
  CHECK (jsonb_typeof("messages") = 'array');

-- The ticket number a patient reads down a phone line. `CX-` and an alphabet
-- with no 0/O and no 1/I/L, so the characters people always mishear cannot occur.
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_reference_code_shape"
  CHECK ("reference_code" ~ '^CX-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$');

-- *** THE ADMIN QUEUE (FR-18.8). ***
-- Everything not yet finished, oldest first. A partial index because open work
-- is the minority of a complaints table that only grows, and it is the only
-- slice the queue screen ever reads.
CREATE INDEX "complaints_open_queue"
  ON "complaints" ("created_at")
  WHERE "status" IN ('open', 'in_progress');

-- Unassigned and waiting: what nobody has picked up yet.
CREATE INDEX "complaints_unassigned"
  ON "complaints" ("created_at")
  WHERE "assigned_to_admin_id" IS NULL AND "status" = 'open';
