-- M-14 Video Consultation: `consultation_participants`, one row per LiveKit
-- CONNECTION - not one per person, and not one per call.
--
-- LiveKit fires join and leave per connection, so a patient whose phone drops
-- signal mid-consultation produces several of each. This table is the whole of
-- the integration's footprint in the database. The room is not stored (its name
-- is a function of `consultations.id`), the join token is not stored (it lives
-- for minutes, and its issue is an `audit_log` row), and nothing is recorded.

-- CreateTable
CREATE TABLE "consultation_participants" (
    -- LiveKit's PA_xxx, generated per connection and never reused. It is the
    -- primary key BECAUSE of that: a redelivered webhook collides here and
    -- changes nothing, instead of adding a second join and doubling the call.
    "livekit_participant_sid" VARCHAR(64) NOT NULL,
    "consultation_id" UUID NOT NULL,
    "party" "party" NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL,
    -- NULL = still connected, or the leave webhook never arrived. Nothing
    -- computes a duration from a NULL; an unclosed row contributes zero.
    "left_at" TIMESTAMPTZ(6),
    "disconnect_reason" VARCHAR(40),

    CONSTRAINT "consultation_participants_pkey" PRIMARY KEY ("livekit_participant_sid")
);

-- CreateIndex
-- The one access path: everything this table answers is asked per consultation
-- and ordered in time - the session window, the call duration, who joined
-- first, and whether a party has any row at all.
CREATE INDEX "consultation_participants_consultation_id_party_joined_at_idx"
  ON "consultation_participants"("consultation_id", "party", "joined_at");

-- AddForeignKey
-- CASCADE: a connection has no meaning without the consultation it was for, and
-- an erasure under SRS 6.4 must not leave attendance evidence behind.
ALTER TABLE "consultation_participants"
  ADD CONSTRAINT "consultation_participants_consultation_id_fkey"
  FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** ONLY THE TWO PARTIES TO THE CONSULTATION. ***
--
-- `party` is a shared enum with four values, but only two of them can ever
-- appear here: a token is minted for the assigned patient and the assigned
-- doctor and for nobody else (FR-8.5). An `admin` or `system` row would mean a
-- third party was in a clinical call, which is the exact thing M-14 is done
-- when it cannot happen - so it is refused by the database as well as by the
-- code that mints the tokens.
ALTER TABLE "consultation_participants"
  ADD CONSTRAINT "consultation_participants_party_is_patient_or_doctor"
  CHECK ("party" IN ('patient', 'doctor'));

-- A connection cannot end before it began. Both timestamps come from LiveKit
-- rather than from us, so this is a check on an external system's clock, and a
-- violation is worth failing on: it would produce a negative call duration.
ALTER TABLE "consultation_participants"
  ADD CONSTRAINT "consultation_participants_leaves_after_joining"
  CHECK ("left_at" IS NULL OR "left_at" >= "joined_at");

-- A disconnect reason without a disconnection is a contradiction: LiveKit sends
-- the reason ON the leave event, so one can never arrive without the other.
ALTER TABLE "consultation_participants"
  ADD CONSTRAINT "consultation_participants_reason_needs_a_leave"
  CHECK ("disconnect_reason" IS NULL OR "left_at" IS NOT NULL);

-- The live-session slice: who is connected RIGHT NOW. A partial index, because
-- being connected is a brief state and a small fraction of the table, while
-- everything else is history that the "is the other party here yet" question
-- never looks at.
CREATE INDEX "consultation_participants_still_connected"
  ON "consultation_participants" ("consultation_id")
  WHERE "left_at" IS NULL;
