-- M-13 Presence and Instant Consult: `instant_consultancy`, one row per doctor
-- OFFERED a request - not one per request.
--
-- Presence and the completion gate are columns on `doctors` (M-05) and already
-- exist. The request itself is a `consultations` row with mode `instant` and no
-- doctor set (M-11). This table is the routing ledger between them.

-- CreateEnum
CREATE TYPE "instant_consultancy_outcome" AS ENUM ('pending', 'accepted', 'declined', 'timed_out', 'superseded');

-- CreateTable
CREATE TABLE "instant_consultancy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "attempt_number" SMALLINT NOT NULL,
    "outcome" "instant_consultancy_outcome" NOT NULL DEFAULT 'pending',
    "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instant_consultancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Routing order is unique per request: there is exactly one first attempt, one
-- second, and so on. Two rows claiming the same position would make "who was
-- asked next" unanswerable, which is the one question this table exists for.
CREATE UNIQUE INDEX "instant_consultancy_consultation_id_attempt_number_key"
  ON "instant_consultancy"("consultation_id", "attempt_number");

-- CreateIndex
CREATE INDEX "instant_consultancy_doctor_id_outcome_idx" ON "instant_consultancy"("doctor_id", "outcome");
CREATE INDEX "instant_consultancy_expires_at_idx" ON "instant_consultancy"("expires_at");

-- AddForeignKey
-- CASCADE on the consultation: an offer has no meaning without the request it
-- was for. NO ACTION on the doctor: this is also the acceptance-rate evidence.
ALTER TABLE "instant_consultancy" ADD CONSTRAINT "instant_consultancy_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "instant_consultancy" ADD CONSTRAINT "instant_consultancy_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- Routing starts at 1 and counts up. A zero or negative attempt would sort
-- ahead of the first provider actually tried.
ALTER TABLE "instant_consultancy"
  ADD CONSTRAINT "instant_consultancy_attempt_is_positive" CHECK ("attempt_number" > 0);

-- An acceptance window that closed before it opened is not a window.
ALTER TABLE "instant_consultancy"
  ADD CONSTRAINT "instant_consultancy_window_moves_forwards" CHECK ("expires_at" > "offered_at");

-- *** ONE ACCEPTANCE PER REQUEST. ***
--
-- Two providers cannot both accept the same instant consultation: the second
-- would arrive in a room the first was already in, and `consultations.doctor_id`
-- holds exactly one of them - so the loser would be treating a patient the
-- record says is somebody else's.
--
-- A PARTIAL unique index over the accepted rows only, because every other
-- outcome may repeat freely: a request declined by five providers is five
-- `declined` rows and that is exactly what the ledger is for.
CREATE UNIQUE INDEX "instant_consultancy_one_acceptance"
  ON "instant_consultancy" ("consultation_id")
  WHERE "outcome" = 'accepted';

-- The live-offer queue: what is still outstanding and about to expire. A
-- partial index, because `pending` is a brief state and a small slice of the
-- table, while the rest is history that the sweep never looks at again.
CREATE INDEX "instant_consultancy_open_offers"
  ON "instant_consultancy" ("expires_at")
  WHERE "outcome" = 'pending';
