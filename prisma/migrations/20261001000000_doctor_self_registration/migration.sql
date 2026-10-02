-- Doctor self-registration: what the doctor states at onboarding, for an admin
-- to verify (`PUT /me/doctor/registration`).

-- CreateEnum
CREATE TYPE "doctor_gender" AS ENUM ('male', 'female', 'other', 'undisclosed');

-- CreateEnum
CREATE TYPE "government_id_type" AS ENUM ('aadhaar', 'passport', 'driving_licence', 'voter_id', 'other');

-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "abha_id" VARCHAR(60),
ADD COLUMN     "basic_qualification" VARCHAR(120),
ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "email" VARCHAR(254),
ADD COLUMN     "fellowship" VARCHAR(120),
ADD COLUMN     "gender" "doctor_gender",
ADD COLUMN     "id_number" VARCHAR(32),
ADD COLUMN     "id_type" "government_id_type",
ADD COLUMN     "id_type_name" VARCHAR(60),
ADD COLUMN     "pg_specialisation" VARCHAR(120),
ADD COLUMN     "super_specialisation" VARCHAR(120);

-- CreateTable
CREATE TABLE "doctor_experience" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctor_id" UUID NOT NULL,
    "designation" VARCHAR(120) NOT NULL,
    "institution" VARCHAR(160) NOT NULL,
    "years" DECIMAL(4,1) NOT NULL,
    "document_id" UUID,
    "sort_order" SMALLINT NOT NULL,

    CONSTRAINT "doctor_experience_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "doctor_experience_years_positive" CHECK ("years" > 0)
);

-- CreateIndex
CREATE INDEX "doctor_experience_doctor_id_sort_order_idx" ON "doctor_experience"("doctor_id", "sort_order");

-- AddForeignKey
ALTER TABLE "doctor_experience" ADD CONSTRAINT "doctor_experience_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
