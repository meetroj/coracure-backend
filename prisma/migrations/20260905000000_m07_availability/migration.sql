-- M-07 Availability and Scheduling: the one table that says when a provider can
-- be booked. There is no slots table - bookable slots are computed from this
-- minus the consultations already holding time, so a diary edit can never leave
-- a stale generated row behind.

-- CreateEnum
CREATE TYPE "availability_rule_type" AS ENUM ('weekly', 'blocked', 'custom_hours');

-- CreateTable
CREATE TABLE "doctor_availability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctor_id" UUID NOT NULL,
    "rule_type" "availability_rule_type" NOT NULL,
    "day_of_week" SMALLINT,
    "specific_date" DATE,
    "start_time" TIME(6),
    "end_time" TIME(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doctor_availability_doctor_id_rule_type_idx" ON "doctor_availability"("doctor_id", "rule_type");

-- CreateIndex
CREATE INDEX "doctor_availability_doctor_id_specific_date_idx" ON "doctor_availability"("doctor_id", "specific_date");

-- AddForeignKey
-- CASCADE: a diary describes a provider and has no meaning without one. This is
-- the opposite of `doctors.specialty_id`, which RESTRICTs, because a specialty
-- is a shared catalogue row and a diary is not.
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
--
-- Every one of these is a rule the scheduling service also applies. They are
-- repeated here because a half-written rule does not fail loudly - it quietly
-- widens or narrows when a provider can be booked, and nobody finds out until
-- a patient is sitting in an empty video room.
-- ###########################################################################

-- *** WHICH COLUMNS EACH RULE TYPE OWNS ***
--   weekly       needs a weekday and both times, and names no date.
--   custom_hours needs a date and both times, and names no weekday.
--   blocked      needs a date, names no weekday, and has EITHER both times
--                (a gap in the day) or neither (a whole day of leave).
-- A weekly row with a null day_of_week would apply to no day at all, and a
-- custom_hours row with null times would silently erase that date's hours.
ALTER TABLE "doctor_availability"
  ADD CONSTRAINT "doctor_availability_shape" CHECK (
    CASE "rule_type"
      WHEN 'weekly' THEN
        "day_of_week" IS NOT NULL AND "specific_date" IS NULL
        AND "start_time" IS NOT NULL AND "end_time" IS NOT NULL
      WHEN 'custom_hours' THEN
        "day_of_week" IS NULL AND "specific_date" IS NOT NULL
        AND "start_time" IS NOT NULL AND "end_time" IS NOT NULL
      WHEN 'blocked' THEN
        "day_of_week" IS NULL AND "specific_date" IS NOT NULL
        AND (("start_time" IS NULL) = ("end_time" IS NULL))
    END
  );

-- 0 Sunday through 6 Saturday, matching JavaScript's getDay(). A smallint would
-- otherwise accept 9, which is a weekday that never comes round.
ALTER TABLE "doctor_availability"
  ADD CONSTRAINT "doctor_availability_day_of_week_range"
  CHECK ("day_of_week" IS NULL OR "day_of_week" BETWEEN 0 AND 6);

-- A window must move forwards. Equal times are refused too: a zero-length
-- window is not a shorter working day, it is a row that means nothing.
ALTER TABLE "doctor_availability"
  ADD CONSTRAINT "doctor_availability_window_moves_forwards"
  CHECK ("start_time" IS NULL OR "end_time" IS NULL OR "start_time" < "end_time");
