-- M-06 Catalogue, Specialty and Allocation Configuration: the specialties,
-- concerns and regions that assignment matches against, plus the two columns
-- SRS 1.2 added - the patient's region, and the price a patient pays for a
-- service rather than for a person.

-- CreateEnum
CREATE TYPE "provider_type" AS ENUM ('doctor', 'non_doctor');

-- CreateTable
CREATE TABLE "specialties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "provider_type" "provider_type" NOT NULL DEFAULT 'non_doctor',
    "can_prescribe" BOOLEAN NOT NULL DEFAULT false,
    "consultation_fee_inr" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "intake_form" JSONB,
    "first_consult_form" JSONB,
    "required_documents" JSONB NOT NULL DEFAULT '[]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concerns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "specialty_id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "match_phrases" JSONB NOT NULL DEFAULT '[]',
    "match_weight" SMALLINT NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "concerns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_regions" (
    "doctor_id" UUID NOT NULL,
    "region_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_regions_pkey" PRIMARY KEY ("doctor_id","region_id")
);

-- AlterTable: the patient's region. Nullable, because every patient who
-- already exists predates the column and assignment treats a missing region as
-- "no preference" rather than as a booking it must refuse.
ALTER TABLE "patients" ADD COLUMN "region_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "specialties_code_key" ON "specialties"("code");

-- CreateIndex
CREATE INDEX "specialties_is_active_idx" ON "specialties"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "concerns_specialty_id_code_key" ON "concerns"("specialty_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "regions_code_key" ON "regions"("code");

-- CreateIndex
CREATE INDEX "regions_is_active_idx" ON "regions"("is_active");

-- CreateIndex
CREATE INDEX "doctor_regions_region_id_idx" ON "doctor_regions"("region_id");

-- CreateIndex: the pair every assignment starts from.
CREATE INDEX "patients_region_id_preferred_language_idx" ON "patients"("region_id", "preferred_language");

-- AddForeignKey
ALTER TABLE "concerns" ADD CONSTRAINT "concerns_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_regions" ADD CONSTRAINT "doctor_regions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_regions" ADD CONSTRAINT "doctor_regions_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The foreign key M-05 left open: `doctors.specialty_id` had the column and the
-- index but nothing to point at until `specialties` existed. RESTRICT, not
-- CASCADE: deleting a specialty that providers are registered under would take
-- the providers with it. A specialty leaves service by `is_active = false`.
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- `required_documents` and `match_phrases` are both LISTS. Stored as an object
-- or a bare string they would not error anywhere - M-05's verification would
-- silently require nothing, and a concern would silently match nothing.
ALTER TABLE "specialties"
  ADD CONSTRAINT "specialties_required_documents_is_array" CHECK (jsonb_typeof(required_documents) = 'array');
ALTER TABLE "concerns"
  ADD CONSTRAINT "concerns_match_phrases_is_array" CHECK (jsonb_typeof(match_phrases) = 'array');

-- A specialty a provider can be registered under must say what to charge for
-- it. Zero is allowed - a free service is a decision - but it must be a
-- decision, not an unset column that silently bills nobody.
ALTER TABLE "specialties"
  ADD CONSTRAINT "specialties_fee_not_negative" CHECK (consultation_fee_inr >= 0);

-- *** THE PRESCRIBING RULE, IN THE SCHEMA ***  Only a doctor-form specialty may
-- prescribe medicines. A non-doctor provider issues advice and a therapy plan.
-- SRS 4.3 and 19.7 make this the line between a psychiatrist and a
-- psychologist, and it is too important to leave to an admin form.
ALTER TABLE "specialties"
  ADD CONSTRAINT "specialties_only_doctors_prescribe"
  CHECK (can_prescribe = false OR provider_type = 'doctor');
