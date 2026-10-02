-- M-02 Identity and Access: the patient and admin account tables.
-- `doctors` is not here - M-05 owns it, together with verification state.

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('pending', 'active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('male', 'female', 'other', 'undisclosed');

-- CreateEnum
CREATE TYPE "admin_permission_level" AS ENUM ('super_admin', 'operations', 'clinical_governance', 'care_coordinator', 'finance', 'content');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "account_status" NOT NULL DEFAULT 'pending',
    "mobile_number" VARCHAR(16) NOT NULL,
    "full_name" VARCHAR(160),
    "date_of_birth" DATE,
    "gender" "gender" NOT NULL DEFAULT 'undisclosed',
    "preferred_language" VARCHAR(40) NOT NULL DEFAULT 'en',
    "token_version" SMALLINT NOT NULL DEFAULT 0,
    "push_token" TEXT,
    "device_id" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "account_status" NOT NULL DEFAULT 'active',
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_2fa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "full_name" VARCHAR(160) NOT NULL,
    "permission_level" "admin_permission_level" NOT NULL,
    "token_version" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_mobile_number_key" ON "patients"("mobile_number");

-- CreateIndex
CREATE INDEX "patients_status_idx" ON "patients"("status");

-- CreateIndex
CREATE INDEX "patients_push_token_idx" ON "patients"("push_token");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "admins_permission_level_status_idx" ON "admins"("permission_level", "status");

-- The rate limit FR-1.9 makes the platform's obligation is counted from
-- audit_log where action = 'login'. Without this it scans the whole log on
-- every OTP request. It is the read path, so it is part of this module.
CREATE INDEX "audit_log_login_attempts"
  ON "audit_log" ("entity_type", "entity_id", "created_at")
  WHERE "action" = 'login';
