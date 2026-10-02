-- M-05 Doctor Registry and Verification: doctor accounts, their credentials,
-- and the per-document approval that gates verification.

-- CreateEnum
CREATE TYPE "doctor_verification_status" AS ENUM ('pending', 'under_review', 'verified', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "doctor_seniority" AS ENUM ('standard', 'expert');

-- CreateEnum
CREATE TYPE "doctor_presence" AS ENUM ('offline', 'available_now', 'request_pending', 'in_consultation', 'completing_notes', 'paused', 'scheduled_only');

-- CreateEnum
CREATE TYPE "doctor_document_type" AS ENUM ('degree_certificate', 'registration_certificate', 'identity_proof', 'address_proof', 'experience_letter', 'profile_photo', 'signature', 'other');

-- CreateEnum
CREATE TYPE "document_review_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mobile_number" VARCHAR(16) NOT NULL,
    "mobile_verified_at" TIMESTAMPTZ(6),
    "token_version" SMALLINT NOT NULL DEFAULT 0,
    "push_token" TEXT,
    "device_id" VARCHAR(120),
    "full_name" VARCHAR(160) NOT NULL,
    "bio" TEXT,
    "languages" JSONB NOT NULL DEFAULT '[]',
    "verification_status" "doctor_verification_status" NOT NULL DEFAULT 'pending',
    "registration_number" VARCHAR(80),
    "qualification" VARCHAR(255),
    "years_of_experience" SMALLINT,
    "verified_by_admin_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "seniority_level" "doctor_seniority" NOT NULL DEFAULT 'standard',
    "specialty_id" UUID,
    "consultation_fee_inr" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "consultation_duration_minutes" SMALLINT NOT NULL DEFAULT 30,
    "buffer_minutes" SMALLINT NOT NULL DEFAULT 5,
    "is_listed" BOOLEAN NOT NULL DEFAULT false,
    "allow_instant_consult" BOOLEAN NOT NULL DEFAULT false,
    "presence" "doctor_presence" NOT NULL DEFAULT 'offline',
    "blocked_by_consultation_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "doctor_id" UUID NOT NULL,
    "document_type" "doctor_document_type" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "review_status" "document_review_status" NOT NULL DEFAULT 'pending',
    "verified_by_admin_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "rejection_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doctors_mobile_number_key" ON "doctors"("mobile_number");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_registration_number_key" ON "doctors"("registration_number");

-- CreateIndex
CREATE INDEX "doctors_verification_status_is_listed_idx" ON "doctors"("verification_status", "is_listed");

-- CreateIndex
CREATE INDEX "doctors_presence_allow_instant_consult_idx" ON "doctors"("presence", "allow_instant_consult");

-- CreateIndex
CREATE INDEX "doctors_specialty_id_idx" ON "doctors"("specialty_id");

-- CreateIndex
CREATE INDEX "doctors_seniority_level_idx" ON "doctors"("seniority_level");

-- CreateIndex
CREATE INDEX "doctors_push_token_idx" ON "doctors"("push_token");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_documents_storage_key_key" ON "doctor_documents"("storage_key");

-- CreateIndex
CREATE INDEX "doctor_documents_doctor_id_document_type_idx" ON "doctor_documents"("doctor_id", "document_type");

-- CreateIndex
CREATE INDEX "doctor_documents_review_status_created_at_idx" ON "doctor_documents"("review_status", "created_at");

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_verified_by_admin_id_fkey" FOREIGN KEY ("verified_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_documents" ADD CONSTRAINT "doctor_documents_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_documents" ADD CONSTRAINT "doctor_documents_verified_by_admin_id_fkey" FOREIGN KEY ("verified_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The foreign key M-03 left open: `consents.doctor_id` had the column and the
-- CHECK but nothing to point at until `doctors` existed.
ALTER TABLE "consents" ADD CONSTRAINT "consents_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- FR-4.4 filters listings by language and `languages` is jsonb, which a btree
-- index cannot answer a containment query from.
CREATE INDEX "doctors_languages_gin" ON "doctors" USING GIN ("languages" jsonb_path_ops);

-- `languages` is an ARRAY of codes. Without this a caller could store an
-- object or a bare string and every listing filter would silently miss them.
ALTER TABLE "doctors"
  ADD CONSTRAINT "doctors_languages_is_array" CHECK (jsonb_typeof(languages) = 'array');

-- A rejection must say why: it is what the doctor has to act on, and a
-- rejected document with no reason is an unanswerable support ticket.
ALTER TABLE "doctor_documents"
  ADD CONSTRAINT "doctor_documents_rejection_has_reason"
  CHECK (review_status <> 'rejected' OR rejection_reason IS NOT NULL);

-- A reviewed document records WHO reviewed it and WHEN; a pending one records
-- neither. Both halves matter - the admin panel reads them off every row.
ALTER TABLE "doctor_documents"
  ADD CONSTRAINT "doctor_documents_review_is_attributed"
  CHECK (
    (review_status = 'pending' AND verified_by_admin_id IS NULL AND verified_at IS NULL)
    OR (review_status <> 'pending' AND verified_at IS NOT NULL)
  );

-- Verified is the state that carries an approval, so it is the state that must
-- name the admin who gave it and when (SRS section 8 puts doctor verification
-- on the client; this is the evidence that it happened).
ALTER TABLE "doctors"
  ADD CONSTRAINT "doctors_verification_is_attributed"
  CHECK (verification_status <> 'verified' OR (verified_by_admin_id IS NOT NULL AND verified_at IS NOT NULL));

-- *** THE LISTING RULE, IN THE SCHEMA ***  A doctor is bookable only when
-- verified AND listed. Keeping it here means no query, no admin action and no
-- future module can put an unverified doctor in front of a patient.
ALTER TABLE "doctors"
  ADD CONSTRAINT "doctors_listed_requires_verified"
  CHECK (is_listed = false OR verification_status = 'verified');
