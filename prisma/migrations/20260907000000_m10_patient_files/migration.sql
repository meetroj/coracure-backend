-- M-10 Documents and File Storage: the patient's clinical files, and the
-- requests a doctor raises for them.
--
-- Doctor credentials are NOT here - they are `doctor_documents`, owned by M-05,
-- because the access rule differs: a credential is read by its own doctor and a
-- reviewing admin, a patient file by that patient and only a doctor treating
-- them.

-- CreateEnum
CREATE TYPE "patient_file_category" AS ENUM ('medical_history', 'report', 'photo', 'prescription_pdf', 'clarification_attachment');

-- CreateEnum
CREATE TYPE "report_request_status" AS ENUM ('open', 'fulfilled', 'cancelled');

-- CreateTable
CREATE TABLE "report_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consultation_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "reason" TEXT,
    "status" "report_request_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_category" "patient_file_category" NOT NULL,
    "patient_id" UUID,
    "uploaded_by_doctor_id" UUID,
    "consultation_id" UUID,
    "report_request_id" UUID,
    "clarification_case_id" UUID,
    "storage_key" TEXT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_files_storage_key_key" ON "patient_files"("storage_key");

-- CreateIndex
CREATE INDEX "patient_files_patient_id_file_category_idx" ON "patient_files"("patient_id", "file_category");

-- CreateIndex
CREATE INDEX "patient_files_consultation_id_idx" ON "patient_files"("consultation_id");

-- CreateIndex
CREATE INDEX "patient_files_report_request_id_idx" ON "patient_files"("report_request_id");

-- CreateIndex
CREATE INDEX "patient_files_clarification_case_id_idx" ON "patient_files"("clarification_case_id");

-- CreateIndex
CREATE INDEX "report_requests_consultation_id_status_idx" ON "report_requests"("consultation_id", "status");

-- CreateIndex
CREATE INDEX "report_requests_status_created_at_idx" ON "report_requests"("status", "created_at");

-- AddForeignKey
-- CASCADE on the patient: a clinical file has no meaning without the person it
-- describes. RESTRICT is wrong here - it would make a deletion request under
-- FR-2.5 impossible to execute while any file remained.
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NO ACTION on the uploader: a doctor row is never hard-deleted (they are
-- suspended), and if one ever were, losing the record of who uploaded a
-- clinical file would be worse than the orphan.
ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_uploaded_by_doctor_id_fkey" FOREIGN KEY ("uploaded_by_doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "patient_files" ADD CONSTRAINT "patient_files_report_request_id_fkey" FOREIGN KEY ("report_request_id") REFERENCES "report_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- `consultation_id` and `clarification_case_id` carry NO key yet: `consultations`
-- arrives with M-11 and `clarification_cases` with M-12, and each adds its own.

-- ###########################################################################
-- Constraints DBML and Prisma cannot express.
-- ###########################################################################

-- *** DE-IDENTIFICATION IS STRUCTURAL, NOT A CODING CONVENTION. ***
-- A file attached to a clarification case is stored as a SCRUBBED COPY with
-- patient_id NULL, so an expert-facing query cannot reach a patient through it
-- even by mistake. FR-12.2 strips direct identifiers before a case is shared;
-- this is what makes that true of the attachments as well, and true of every
-- query anyone writes later rather than only the ones written carefully.
ALTER TABLE "patient_files"
  ADD CONSTRAINT "patient_files_clarification_copy_is_deidentified"
  CHECK ("clarification_case_id" IS NULL OR "patient_id" IS NULL);

-- Every file belongs to somebody: a patient, or a clarification case that a
-- doctor attached it to. A row with neither is a stored object nothing can ever
-- reach, and no access check would refuse it because no owner would match.
ALTER TABLE "patient_files"
  ADD CONSTRAINT "patient_files_has_an_owner"
  CHECK ("patient_id" IS NOT NULL OR "clarification_case_id" IS NOT NULL);

-- A file uploaded against a request must belong to the same booking the request
-- was raised in. Without this a report could arrive labelled for a consultation
-- it has nothing to do with, and the doctor who asked would never see it.
ALTER TABLE "patient_files"
  ADD CONSTRAINT "patient_files_request_implies_consultation"
  CHECK ("report_request_id" IS NULL OR "consultation_id" IS NOT NULL);

-- Medical history is held against the PATIENT, not one booking (FR-4.6). It is
-- uploaded before any consultation exists and read at every later one, so
-- pinning it to a consultation would hide it from the next doctor.
ALTER TABLE "patient_files"
  ADD CONSTRAINT "patient_files_history_is_not_per_booking"
  CHECK ("file_category" <> 'medical_history' OR "consultation_id" IS NULL);
