-- M-03 Consent and Legal: legal copy, the evidence of accepting it, and the
-- data-deletion workflow.

-- CreateEnum
CREATE TYPE "legal_document_type" AS ENUM ('teleconsultation_consent', 'privacy_policy', 'terms_of_use', 'refund_policy', 'reconsult_policy', 'doctor_agreement');

-- CreateEnum
CREATE TYPE "deletion_status" AS ENUM ('requested', 'in_review', 'approved', 'rejected', 'executed', 'failed');

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_type" "legal_document_type" NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID,
    "doctor_id" UUID,
    "legal_document_id" UUID NOT NULL,
    "document_type" "legal_document_type" NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" INET,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_deletion_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "status" "deletion_status" NOT NULL DEFAULT 'requested',
    "reason" TEXT,
    "reviewed_by_admin_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "execution_outcome" JSONB,
    "executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_documents_document_type_version_key" ON "legal_documents"("document_type", "version");

-- CreateIndex
CREATE INDEX "legal_documents_document_type_is_current_idx" ON "legal_documents"("document_type", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "consents_patient_id_legal_document_id_key" ON "consents"("patient_id", "legal_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "consents_doctor_id_legal_document_id_key" ON "consents"("doctor_id", "legal_document_id");

-- CreateIndex
CREATE INDEX "consents_patient_id_document_type_idx" ON "consents"("patient_id", "document_type");

-- CreateIndex
CREATE INDEX "data_deletion_requests_status_created_at_idx" ON "data_deletion_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "data_deletion_requests_patient_id_idx" ON "data_deletion_requests"("patient_id");

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_document_id_fkey" FOREIGN KEY ("legal_document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ###########################################################################
-- Constraints DBML and Prisma cannot express. From db/README.md, "Must be
-- added by hand in the first migration". Without these the schema is wrong.
-- ###########################################################################

-- A consent belongs to exactly one person, never both and never neither.
ALTER TABLE "consents"
  ADD CONSTRAINT "consents_one_subject" CHECK (num_nonnulls(patient_id, doctor_id) = 1);

-- `consents.document_type` is denormalised so the pre-consult check needs no
-- join. This composite foreign key makes it impossible for that copy to
-- disagree with the document it points at.
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_id_document_type_key" UNIQUE (id, document_type);
ALTER TABLE "consents"
  ADD CONSTRAINT "consents_document_type_matches_document"
  FOREIGN KEY (legal_document_id, document_type) REFERENCES "legal_documents" (id, document_type);

-- Exactly one current version per document type. `is_current` decides what is
-- served and what new users must accept, so two of them is not a display bug -
-- it is two different texts both claiming to be the one in force.
CREATE UNIQUE INDEX "legal_documents_one_current_per_type"
  ON "legal_documents" (document_type)
  WHERE is_current;
