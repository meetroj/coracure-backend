-- SQL dump generated using DBML (dbml.dbdiagram.io)
-- Database: PostgreSQL
-- Generated at: 2026-09-28T09:27:36.983Z

CREATE TYPE "account_status" AS ENUM (
  'pending',
  'active',
  'suspended',
  'deleted'
);

CREATE TYPE "gender" AS ENUM (
  'male',
  'female',
  'other',
  'undisclosed'
);

CREATE TYPE "admin_permission_level" AS ENUM (
  'super_admin',
  'operations',
  'clinical_governance',
  'care_coordinator',
  'finance',
  'content'
);

CREATE TYPE "doctor_seniority" AS ENUM (
  'standard',
  'expert'
);

CREATE TYPE "doctor_verification_status" AS ENUM (
  'pending',
  'under_review',
  'verified',
  'rejected',
  'suspended'
);

CREATE TYPE "doctor_presence" AS ENUM (
  'offline',
  'available_now',
  'request_pending',
  'in_consultation',
  'completing_notes',
  'paused',
  'scheduled_only'
);

CREATE TYPE "doctor_document_type" AS ENUM (
  'degree_certificate',
  'registration_certificate',
  'identity_proof',
  'address_proof',
  'experience_letter',
  'profile_photo',
  'signature',
  'other'
);

CREATE TYPE "document_review_status" AS ENUM (
  'pending',
  'approved',
  'rejected'
);

CREATE TYPE "provider_type" AS ENUM (
  'doctor',
  'non_doctor'
);

CREATE TYPE "availability_rule_type" AS ENUM (
  'weekly',
  'blocked',
  'custom_hours'
);

CREATE TYPE "consultation_mode" AS ENUM (
  'scheduled',
  'instant'
);

CREATE TYPE "consultation_channel" AS ENUM (
  'video',
  'audio'
);

CREATE TYPE "consultation_status" AS ENUM (
  'pending_payment',
  'scheduled',
  'awaiting_doctor',
  'in_progress',
  'awaiting_documentation',
  'completed',
  'cancelled',
  'no_show',
  'expired'
);

CREATE TYPE "party" AS ENUM (
  'patient',
  'doctor',
  'admin',
  'system'
);

CREATE TYPE "followup_status" AS ENUM (
  'none',
  'active',
  'completed',
  'cancelled'
);

CREATE TYPE "instant_consultancy_outcome" AS ENUM (
  'pending',
  'accepted',
  'declined',
  'timed_out',
  'superseded'
);

CREATE TYPE "payment_status" AS ENUM (
  'created',
  'pending',
  'paid',
  'failed',
  'refunded'
);

CREATE TYPE "risk_category" AS ENUM (
  'low',
  'moderate',
  'high'
);

CREATE TYPE "patient_file_category" AS ENUM (
  'medical_history',
  'report',
  'photo',
  'prescription_pdf',
  'clarification_attachment'
);

CREATE TYPE "report_request_status" AS ENUM (
  'open',
  'fulfilled',
  'cancelled'
);

CREATE TYPE "report_request_category" AS ENUM (
  'prescription',
  'lab',
  'history',
  'other'
);

CREATE TYPE "checkin_status" AS ENUM (
  'green',
  'amber',
  'red'
);

CREATE TYPE "safety_alert_type" AS ENUM (
  'red_flag',
  'amber',
  'missed_checkin',
  'medication_side_effect',
  'followup_due'
);

CREATE TYPE "clarification_status" AS ENUM (
  'draft',
  'posted',
  'awaiting_response',
  'response_received',
  'clarification_asked',
  'reviewed',
  'closed'
);

CREATE TYPE "clarification_urgency" AS ENUM (
  'routine',
  'soon',
  'urgent'
);

CREATE TYPE "content_item_type" AS ENUM (
  'self_help_tool',
  'education_module',
  'blog_article',
  'caregiver_guide',
  'emergency_guidance',
  'support_org',
  'clinical_reference'
);

CREATE TYPE "content_review_status" AS ENUM (
  'draft',
  'in_clinical_review',
  'published',
  'archived'
);

CREATE TYPE "complaint_status" AS ENUM (
  'open',
  'in_progress',
  'resolved',
  'rejected'
);

CREATE TYPE "complaint_category" AS ENUM (
  'consultation_quality',
  'doctor_conduct',
  'technical_issue',
  'payment_issue',
  'other'
);

CREATE TYPE "legal_document_type" AS ENUM (
  'teleconsultation_consent',
  'privacy_policy',
  'terms_of_use',
  'refund_policy',
  'reconsult_policy',
  'doctor_agreement'
);

CREATE TYPE "deletion_status" AS ENUM (
  'requested',
  'in_review',
  'approved',
  'rejected',
  'executed',
  'failed'
);

CREATE TYPE "notification_status" AS ENUM (
  'queued',
  'sent',
  'failed'
);

CREATE TYPE "audit_action" AS ENUM (
  'create',
  'read',
  'update',
  'delete',
  'export',
  'login',
  'verify',
  'webhook'
);

CREATE TYPE "actor_type" AS ENUM (
  'patient',
  'doctor',
  'admin',
  'system'
);

CREATE TABLE "patients" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "status" account_status NOT NULL DEFAULT 'pending',
  "mobile_number" varchar(16) UNIQUE NOT NULL,
  "full_name" varchar(160),
  "date_of_birth" date,
  "gender" gender NOT NULL DEFAULT 'undisclosed',
  "preferred_language" varchar(40) NOT NULL DEFAULT 'en',
  "region_id" uuid,
  "token_version" smallint NOT NULL DEFAULT 0,
  "push_token" text,
  "device_id" varchar(120),
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "admins" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "status" account_status NOT NULL DEFAULT 'active',
  "email" varchar(255) UNIQUE NOT NULL,
  "password_hash" text NOT NULL,
  "is_2fa_enabled" boolean NOT NULL DEFAULT false,
  "full_name" varchar(160) NOT NULL,
  "permission_level" admin_permission_level NOT NULL,
  "token_version" smallint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "doctors" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "mobile_number" varchar(16) UNIQUE NOT NULL,
  "mobile_verified_at" timestamptz,
  "token_version" smallint NOT NULL DEFAULT 0,
  "push_token" text,
  "device_id" varchar(120),
  "full_name" varchar(160) NOT NULL,
  "bio" text,
  "languages" jsonb NOT NULL DEFAULT ('[]'),
  "verification_status" doctor_verification_status NOT NULL DEFAULT 'pending',
  "registration_number" varchar(80) UNIQUE,
  "qualification" varchar(255),
  "years_of_experience" smallint,
  "verified_by_admin_id" uuid,
  "verified_at" timestamptz,
  "seniority_level" doctor_seniority NOT NULL DEFAULT 'standard',
  "specialty_id" uuid,
  "consultation_fee_inr" numeric(10,2) NOT NULL DEFAULT 0,
  "consultation_duration_minutes" smallint NOT NULL DEFAULT 30,
  "buffer_minutes" smallint NOT NULL DEFAULT 5,
  "is_listed" boolean NOT NULL DEFAULT false,
  "allow_instant_consult" boolean NOT NULL DEFAULT false,
  "bank_verified" boolean NOT NULL DEFAULT false,
  "presence" doctor_presence NOT NULL DEFAULT 'offline',
  "blocked_by_consultation_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "doctor_documents" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "doctor_id" uuid NOT NULL,
  "document_type" doctor_document_type NOT NULL,
  "storage_key" text UNIQUE NOT NULL,
  "file_name" varchar(255) NOT NULL,
  "review_status" document_review_status NOT NULL DEFAULT 'pending',
  "verified_by_admin_id" uuid,
  "verified_at" timestamptz,
  "rejection_reason" varchar(255),
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "specialties" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "code" varchar(60) UNIQUE NOT NULL,
  "name" varchar(120) NOT NULL,
  "description" text,
  "provider_type" provider_type NOT NULL DEFAULT 'non_doctor',
  "can_prescribe" boolean NOT NULL DEFAULT false,
  "consultation_fee_inr" numeric(10,2) NOT NULL DEFAULT 0,
  "intake_form" jsonb,
  "first_consult_form" jsonb,
  "required_documents" jsonb NOT NULL DEFAULT ('[]'),
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "regions" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "code" varchar(60) UNIQUE NOT NULL,
  "name" varchar(120) NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "doctor_regions" (
  "doctor_id" uuid NOT NULL,
  "region_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  PRIMARY KEY ("doctor_id", "region_id")
);

CREATE TABLE "concerns" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "specialty_id" uuid NOT NULL,
  "code" varchar(60) NOT NULL,
  "name" varchar(120) NOT NULL,
  "match_phrases" jsonb NOT NULL DEFAULT ('[]'),
  "match_weight" smallint NOT NULL DEFAULT 1,
  "is_active" boolean NOT NULL DEFAULT true
);

CREATE TABLE "doctor_availability" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "doctor_id" uuid NOT NULL,
  "rule_type" availability_rule_type NOT NULL,
  "day_of_week" smallint,
  "specific_date" date,
  "start_time" time,
  "end_time" time,
  "channels" consultation_channel[] NOT NULL DEFAULT ('{video,audio}'),
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "consultations" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "reference_code" varchar(24) UNIQUE NOT NULL,
  "patient_id" uuid NOT NULL,
  "doctor_id" uuid,
  "specialty_id" uuid NOT NULL,
  "concern_id" uuid,
  "mode" consultation_mode NOT NULL,
  "channel" consultation_channel NOT NULL DEFAULT 'video',
  "status" consultation_status NOT NULL DEFAULT 'pending_payment',
  "scheduled_start_at" timestamptz,
  "duration_minutes" smallint NOT NULL,
  "hold_expires_at" timestamptz,
  "intake_answers" jsonb,
  "rescheduled_from_consultation_id" uuid,
  "cancelled_at" timestamptz,
  "cancelled_by_party" party,
  "cancellation_reason" varchar(200),
  "followup_pathway_id" uuid,
  "followup_starts_on" date,
  "followup_status" followup_status NOT NULL DEFAULT 'none',
  "extra_checkin_questions" jsonb NOT NULL DEFAULT ('[]'),
  "feedback_rating" smallint,
  "feedback_comment" text,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "consultation_participants" (
  "livekit_participant_sid" varchar(64) PRIMARY KEY,
  "consultation_id" uuid NOT NULL,
  "party" party NOT NULL,
  "joined_at" timestamptz NOT NULL,
  "left_at" timestamptz,
  "disconnect_reason" varchar(40)
);

CREATE TABLE "instant_consultancy" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "consultation_id" uuid NOT NULL,
  "doctor_id" uuid NOT NULL,
  "attempt_number" smallint NOT NULL,
  "outcome" instant_consultancy_outcome NOT NULL DEFAULT 'pending',
  "offered_at" timestamptz NOT NULL DEFAULT (now()),
  "expires_at" timestamptz NOT NULL
);

CREATE TABLE "payments" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "consultation_id" uuid UNIQUE NOT NULL,
  "consultation_fee" numeric(10,2) NOT NULL,
  "convenience_fee_pct" numeric(5,2) NOT NULL,
  "convenience_fee" numeric(10,2) NOT NULL,
  "gst_pct" numeric(5,2) NOT NULL,
  "gst_amount" numeric(10,2) NOT NULL,
  "status" payment_status NOT NULL DEFAULT 'created',
  "gateway_order_id" varchar(120) UNIQUE,
  "gateway_payment_id" varchar(120) UNIQUE,
  "payment_method" varchar(40),
  "paid_at" timestamptz,
  "failure_reason" varchar(200),
  "refund_amount" numeric(10,2) NOT NULL DEFAULT 0,
  "refund_reason" varchar(200),
  "refund_initiated_by_admin_id" uuid,
  "gateway_refund_id" varchar(120) UNIQUE,
  "refunded_at" timestamptz,
  "payout_paid_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "clinical_records" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "consultation_id" uuid UNIQUE NOT NULL,
  "chief_complaint" text NOT NULL,
  "clinical_history" text,
  "diagnosis" text,
  "is_diagnosis_provisional" boolean NOT NULL DEFAULT true,
  "risk_category" risk_category NOT NULL,
  "referral_note" varchar(255),
  "medicines" jsonb NOT NULL DEFAULT ('[]'),
  "advice_covered" text,
  "advice_home_practice" text,
  "advice_next_focus" text,
  "advice_warning_signs" text,
  "case_summary" text,
  "recommended_content_ids" jsonb NOT NULL DEFAULT ('[]'),
  "finalised_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "patient_files" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "file_category" patient_file_category NOT NULL,
  "patient_id" uuid,
  "uploaded_by_doctor_id" uuid,
  "consultation_id" uuid,
  "report_request_id" uuid,
  "clarification_case_id" uuid,
  "storage_key" text UNIQUE NOT NULL,
  "file_name" varchar(255) NOT NULL,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "report_requests" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "consultation_id" uuid NOT NULL,
  "title" varchar(160) NOT NULL,
  "category" report_request_category NOT NULL DEFAULT 'other',
  "reason" text,
  "status" report_request_status NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "followup_pathways" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "code" varchar(60) NOT NULL,
  "name" varchar(120) NOT NULL,
  "version" smallint NOT NULL DEFAULT 1,
  "duration_days" smallint NOT NULL DEFAULT 7,
  "questions" jsonb NOT NULL,
  "red_flag_rules" jsonb NOT NULL,
  "is_current" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "checkin_responses" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "consultation_id" uuid NOT NULL,
  "checkin_date" date NOT NULL,
  "answers" jsonb NOT NULL,
  "status" checkin_status NOT NULL,
  "submitted_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "safety_alerts" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "alert_type" safety_alert_type NOT NULL,
  "consultation_id" uuid NOT NULL,
  "checkin_response_id" uuid,
  "reason" varchar(255),
  "acknowledged_by_admin_id" uuid,
  "acknowledged_by_doctor_id" uuid,
  "acknowledged_at" timestamptz,
  "closed_at" timestamptz,
  "closing_note" text,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "clarification_cases" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "treating_doctor_id" uuid NOT NULL,
  "source_consultation_id" uuid,
  "title" varchar(200) NOT NULL,
  "topic" varchar(120),
  "patient_age" smallint,
  "patient_gender" gender,
  "brief_history" text NOT NULL,
  "diagnosis" text,
  "current_plan" text,
  "specific_doubt" text NOT NULL,
  "urgency" clarification_urgency NOT NULL DEFAULT 'routine',
  "expert_doctor_id" uuid,
  "assigned_at" timestamptz,
  "messages" jsonb NOT NULL DEFAULT ('[]'),
  "status" clarification_status NOT NULL DEFAULT 'draft',
  "posted_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "content_items" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "item_type" content_item_type NOT NULL,
  "slug" varchar(160) UNIQUE NOT NULL,
  "title" varchar(200) NOT NULL,
  "summary" varchar(400),
  "body" jsonb NOT NULL,
  "concern_id" uuid,
  "specialty_id" uuid,
  "cover_storage_key" text,
  "is_verified_org" boolean,
  "review_status" content_review_status NOT NULL DEFAULT 'draft',
  "reviewed_by_admin_id" uuid,
  "reviewed_at" timestamptz,
  "sort_order" smallint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "complaints" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "reference_code" varchar(24) UNIQUE NOT NULL,
  "patient_id" uuid NOT NULL,
  "consultation_id" uuid,
  "category" complaint_category NOT NULL,
  "subject" varchar(200) NOT NULL,
  "description" text NOT NULL,
  "status" complaint_status NOT NULL DEFAULT 'open',
  "assigned_to_admin_id" uuid,
  "messages" jsonb NOT NULL DEFAULT ('[]'),
  "resolved_at" timestamptz,
  "resolution_note" text,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "legal_documents" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "document_type" legal_document_type NOT NULL,
  "version" varchar(20) NOT NULL,
  "title" varchar(200) NOT NULL,
  "body" text NOT NULL,
  "is_current" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "consents" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "patient_id" uuid,
  "doctor_id" uuid,
  "legal_document_id" uuid NOT NULL,
  "document_type" legal_document_type NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT (now()),
  "ip_address" inet
);

CREATE TABLE "data_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "patient_id" uuid NOT NULL,
  "status" deletion_status NOT NULL DEFAULT 'requested',
  "reason" text,
  "reviewed_by_admin_id" uuid,
  "reviewed_at" timestamptz,
  "review_note" text,
  "execution_outcome" jsonb,
  "executed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "notifications" (
  "id" bigserial PRIMARY KEY,
  "patient_id" uuid,
  "doctor_id" uuid,
  "admin_id" uuid,
  "template_code" varchar(80) NOT NULL,
  "title" varchar(200) NOT NULL,
  "body" text NOT NULL,
  "deep_link_data" jsonb,
  "consultation_id" uuid,
  "status" notification_status NOT NULL DEFAULT 'queued',
  "sent_at" timestamptz,
  "read_at" timestamptz,
  "failure_reason" varchar(200),
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "app_config" (
  "id" uuid PRIMARY KEY DEFAULT (gen_random_uuid()),
  "key" varchar(160) UNIQUE NOT NULL,
  "value" jsonb NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT (now()),
  "updated_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE TABLE "audit_log" (
  "id" bigserial PRIMARY KEY,
  "actor_type" actor_type NOT NULL,
  "actor_id" uuid,
  "action" audit_action NOT NULL,
  "entity_type" varchar(80) NOT NULL,
  "entity_id" varchar(80) NOT NULL,
  "consultation_id" uuid,
  "metadata" jsonb,
  "ip_address" inet,
  "created_at" timestamptz NOT NULL DEFAULT (now())
);

CREATE INDEX ON "patients" ("status");

CREATE INDEX ON "patients" ("push_token");

CREATE INDEX ON "patients" ("region_id", "preferred_language");

CREATE INDEX ON "admins" ("permission_level", "status");

CREATE INDEX ON "doctors" ("verification_status", "is_listed");

CREATE INDEX ON "doctors" ("presence", "allow_instant_consult");

CREATE INDEX ON "doctors" ("specialty_id");

CREATE INDEX ON "doctors" ("seniority_level");

CREATE INDEX ON "doctors" ("push_token");

CREATE INDEX ON "doctor_documents" ("doctor_id", "document_type");

CREATE INDEX ON "doctor_documents" ("review_status", "created_at");

CREATE INDEX ON "doctor_regions" ("region_id");

CREATE UNIQUE INDEX ON "concerns" ("specialty_id", "code");

CREATE INDEX ON "doctor_availability" ("doctor_id", "rule_type");

CREATE INDEX ON "doctor_availability" ("doctor_id", "specific_date");

CREATE INDEX ON "consultations" ("patient_id", "status");

CREATE INDEX ON "consultations" ("doctor_id", "status");

CREATE INDEX ON "consultations" ("doctor_id", "scheduled_start_at");

CREATE INDEX ON "consultations" ("status", "scheduled_start_at");

CREATE INDEX ON "consultations" ("followup_status", "followup_starts_on");

CREATE INDEX ON "consultations" ("hold_expires_at");

CREATE INDEX ON "consultation_participants" ("consultation_id", "party", "joined_at");

CREATE UNIQUE INDEX ON "instant_consultancy" ("consultation_id", "attempt_number");

CREATE INDEX ON "instant_consultancy" ("doctor_id", "outcome");

CREATE INDEX ON "instant_consultancy" ("expires_at");

CREATE INDEX ON "payments" ("status", "created_at");

CREATE INDEX ON "payments" ("paid_at");

CREATE INDEX ON "clinical_records" ("finalised_at");

CREATE INDEX ON "patient_files" ("patient_id", "file_category");

CREATE INDEX ON "patient_files" ("consultation_id");

CREATE INDEX ON "patient_files" ("report_request_id");

CREATE INDEX ON "patient_files" ("clarification_case_id");

CREATE INDEX ON "report_requests" ("consultation_id", "status");

CREATE INDEX ON "report_requests" ("status", "created_at");

CREATE UNIQUE INDEX ON "followup_pathways" ("code", "version");

CREATE INDEX ON "followup_pathways" ("code", "is_current");

CREATE UNIQUE INDEX ON "checkin_responses" ("consultation_id", "checkin_date");

CREATE INDEX ON "checkin_responses" ("status", "submitted_at");

CREATE INDEX ON "safety_alerts" ("alert_type", "created_at");

CREATE INDEX ON "safety_alerts" ("consultation_id");

CREATE INDEX ON "clarification_cases" ("treating_doctor_id", "status");

CREATE INDEX ON "clarification_cases" ("expert_doctor_id", "status");

CREATE INDEX ON "clarification_cases" ("status", "urgency");

CREATE INDEX ON "content_items" ("item_type", "review_status");

CREATE INDEX ON "content_items" ("concern_id", "item_type");

CREATE INDEX ON "complaints" ("status", "created_at");

CREATE INDEX ON "complaints" ("patient_id");

CREATE UNIQUE INDEX ON "legal_documents" ("document_type", "version");

CREATE INDEX ON "legal_documents" ("document_type", "is_current");

CREATE UNIQUE INDEX ON "consents" ("patient_id", "legal_document_id");

CREATE UNIQUE INDEX ON "consents" ("doctor_id", "legal_document_id");

CREATE INDEX ON "consents" ("patient_id", "document_type");

CREATE INDEX ON "data_deletion_requests" ("status", "created_at");

CREATE INDEX ON "data_deletion_requests" ("patient_id");

CREATE INDEX ON "notifications" ("patient_id", "created_at");

CREATE INDEX ON "notifications" ("doctor_id", "created_at");

CREATE INDEX ON "notifications" ("admin_id", "created_at");

CREATE INDEX ON "notifications" ("status", "created_at");

CREATE INDEX ON "audit_log" ("actor_type", "actor_id", "created_at");

CREATE INDEX ON "audit_log" ("entity_type", "entity_id");

CREATE INDEX ON "audit_log" ("action", "created_at");

CREATE INDEX ON "audit_log" ("consultation_id");

COMMENT ON TABLE "patients" IS 'No password - patients authenticate by OTP only. No mobile_verified_at: a patient row is only ever written after Slide confirms the OTP, so the row existing IS the verification, and when it happened is created_at plus the audit_log row where action = login. No email: no requirement names one and the platform has no mail transport, so receipts stay with the gateway. No emergency contact either - FR-3.4 and 6.3 give emergency guidance as content, they do not collect a contact.';

COMMENT ON COLUMN "patients"."mobile_number" IS 'the sign-in identifier, stored in E.164 form (+919876543210). FR-2.2 asks for contact, and this is it.';

COMMENT ON COLUMN "patients"."date_of_birth" IS 'age is derived from this, never stored';

COMMENT ON COLUMN "patients"."preferred_language" IS '*** MATCHED ON *** a provider who does not speak this is never assigned - SRS FR-20.4';

COMMENT ON COLUMN "patients"."region_id" IS 'the state the patient is in. A PREFERENCE for assignment, relaxed when the region pool is empty - SRS FR-20.5';

COMMENT ON COLUMN "patients"."token_version" IS '*** REVOCATION *** bump to invalidate every token issued for this account';

COMMENT ON COLUMN "patients"."device_id" IS 'named by FR-1.8';

COMMENT ON TABLE "admins" IS 'care_coordinator is the narrower level that receives safety and follow-up alerts, read in-panel from notifications. Who created this account is the audit_log row where action = create and entity_type = admin.';

COMMENT ON COLUMN "admins"."email" IS 'the sign-in identifier';

COMMENT ON COLUMN "admins"."is_2fa_enabled" IS 'when true, require an OTP challenge through Slide after password verification';

COMMENT ON COLUMN "admins"."permission_level" IS 'gates which panel sections and data this admin sees';

COMMENT ON COLUMN "admins"."token_version" IS '*** REVOCATION *** bump to invalidate every token issued for this account';

COMMENT ON TABLE "doctors" IS 'No reliability counters and no active_consultation_id - both are counted from consultations and instant_consultancy when needed. Only the completion gate is cached, because it is checked on every instant routing decision. No verification_note: a rejection is per document (doctor_documents.rejection_reason), which is what the doctor must act on; the admin note on the doctor decision itself is the metadata of the audit_log row where action = verify. No last_heartbeat_at: presence is carried on the realtime channel (M-13), so the socket already knows who is live - its disconnect handler, and a sweep at boot, write presence = offline. A heartbeat column is a row write per online doctor every few seconds for a fact the channel holds already. No email (nothing sends one, and sign-in is by mobile), no gender and no registration_council (no listing, filter or profile in the SRS shows them), no created_by (that is the audit_log row where action = create).';

COMMENT ON COLUMN "doctors"."mobile_number" IS 'the sign-in identifier, stored in E.164 form (+919876543210) - doctors sign in by OTP, FR-1.2';

COMMENT ON COLUMN "doctors"."mobile_verified_at" IS 'null = the doctor has never completed an OTP sign-in on this number';

COMMENT ON COLUMN "doctors"."token_version" IS '*** REVOCATION *** bump to invalidate every token issued for this account';

COMMENT ON COLUMN "doctors"."device_id" IS 'named by FR-1.8';

COMMENT ON COLUMN "doctors"."bio" IS 'profile copy, FR-4.3';

COMMENT ON COLUMN "doctors"."languages" IS 'filtered on, FR-4.4';

COMMENT ON COLUMN "doctors"."registration_number" IS 'medical council registration, shown in listings by FR-4.2';

COMMENT ON COLUMN "doctors"."verified_by_admin_id" IS 'admin who approved the DOCTOR; each document is signed off separately. Read on every row of the approval queue, so it is not a join to audit_log.';

COMMENT ON COLUMN "doctors"."seniority_level" IS 'admin-granted. expert is the only level that may be ASKED for a case opinion - it grants sight of nothing on its own.';

COMMENT ON COLUMN "doctors"."specialty_id" IS 'one specialty. It decides prescribing eligibility.';

COMMENT ON COLUMN "doctors"."consultation_fee_inr" IS '*** WHAT THIS PROVIDER IS PAID, not what the patient is charged. *** The patient price is specialties.consultation_fee_inr, because a patient who cannot choose the provider must be quoted before one is assigned - SRS FR-7.8, FR-7.9';

COMMENT ON COLUMN "doctors"."is_listed" IS 'admin toggle. Search needs verification_status = verified AND this true.';

COMMENT ON COLUMN "doctors"."bank_verified" IS 'admin-set once payout details are checked outside this system. No account number or IFSC is ever stored here.';

COMMENT ON COLUMN "doctors"."blocked_by_consultation_id" IS '*** THE COMPLETION GATE *** set while documentation is outstanding';

COMMENT ON TABLE "doctor_documents" IS 'Separate from patient_files on purpose - these are the doctor own credentials, read only by admins and that doctor. No size_bytes and no mime_type: the object store is authoritative for both - it serves the Content-Type it was uploaded with, and the preview icon comes off the file_name extension. No expires_on: renewal chasing needs a roster with certificates already expiring, and verifying registrations is the client obligation under SRS section 8, not work this release does.';

COMMENT ON COLUMN "doctor_documents"."storage_key" IS 'object-store key, never exposed to the client';

COMMENT ON COLUMN "doctor_documents"."verified_by_admin_id" IS 'the admin who checked THIS document';

COMMENT ON TABLE "specialties" IS 'Adding a row here is how a new specialty goes live, on either registration form. No code change, no app release. No default_duration_min - the bookable length is doctors.consultation_duration_min, and a seed value for an admin form field is not data. No icon_key - the app maps code to an icon it ships, and a specialty added after release shows the default one until the next build. No sort_order - the five launch specialties list by name, and a hand-ordered shelf is not something any screen asks for.';

COMMENT ON COLUMN "specialties"."code" IS 'psychiatry, psychology, therapy, counselling, de_addiction';

COMMENT ON COLUMN "specialties"."provider_type" IS '*** WHICH REGISTRATION FORM *** a provider of this specialty is created on, and therefore whether a medical council registration number is required - SRS FR-19.7';

COMMENT ON COLUMN "specialties"."can_prescribe" IS 'THE prescribing gate. psychiatry true, the rest false. Correlated with provider_type at launch but kept separate: prescribing is a clinical permission, provider_type is a professional category.';

COMMENT ON COLUMN "specialties"."consultation_fee_inr" IS '*** WHAT THE PATIENT IS CHARGED *** quoted before a provider is assigned - SRS FR-7.8';

COMMENT ON COLUMN "specialties"."intake_form" IS 'ordered field list - key, label, input type, options, required';

COMMENT ON COLUMN "specialties"."first_consult_form" IS 'the medical-history block, asked only on a first consultation';

COMMENT ON COLUMN "specialties"."required_documents" IS 'doctor_document_type values a doctor of this specialty must submit';

COMMENT ON TABLE "regions" IS 'Rows, not an enum, so the client adds a region from the panel with no release (SRS FR-19.8) - and so the granularity can change from states to something else later without a migration. No sort_order: regions list by name. No parent_region_id: nothing in this release asks for a hierarchy, and a self-referencing tree nobody queries is a cost with no reader.';

COMMENT ON COLUMN "regions"."code" IS 'karnataka, maharashtra, delhi - a state or province, SRS FR-20.11';

COMMENT ON TABLE "doctor_regions" IS 'Owned by M-05, because which regions a provider serves is an attribute of that provider - exactly as doctors.specialty_id is, while the catalogue it points at belongs to M-06. No is_active: a pool a provider has left is a row deleted, not a row flagged. No assigned_by_admin_id: who put them in the pool, and when, is the audit_log row.';

COMMENT ON TABLE "concerns" IS 'No sort_order - a concern list is ordered by name, and search results are ordered by match_weight against the query, never by a hand-set position.';

COMMENT ON COLUMN "concerns"."code" IS 'depression, anxiety, sleep, ocd, substance_use, psychosis, child_adolescent, womens_mental_health, elderly_care';

COMMENT ON COLUMN "concerns"."name" IS 'also the plain-language match reason FR-5.4 shows - "matched to: sleep, anxiety"';

COMMENT ON COLUMN "concerns"."match_phrases" IS 'trigger phrases and synonyms - English, Hindi and mixed';

COMMENT ON TABLE "doctor_availability" IS 'A rule that no longer applies is deleted, not deactivated - there is no is_active, and no free-text reason that no screen reads.';

COMMENT ON COLUMN "doctor_availability"."day_of_week" IS 'required when rule_type = weekly. 0 Sunday through 6 Saturday';

COMMENT ON COLUMN "doctor_availability"."specific_date" IS 'required when rule_type = blocked or custom_hours';

COMMENT ON COLUMN "doctor_availability"."channels" IS 'which remote channels this slot is offered on. Defaults to both so an existing rule keeps working unchanged.';

COMMENT ON TABLE "consultations" IS 'NO video or audio is recorded. Join and leave times live in consultation_participants, one row per LiveKit connection, so status = no_show plus the absence of a row for that party is what names the no-show. The follow-up window ends at followup_starts_on plus the pinned pathway duration_days, so the daily check-in job reads the pathway rather than a second copy of the date. Double-booking, and the partial index behind the pending-documentation worklist, are added by hand in the first migration - see db/README.md.';

COMMENT ON COLUMN "consultations"."id" IS '*** THE CONSULTATION ID ***';

COMMENT ON COLUMN "consultations"."doctor_id" IS 'NULL only while an instant request is still searching for a doctor';

COMMENT ON COLUMN "consultations"."specialty_id" IS 'BOOKING-TIME SNAPSHOT. Not derivable: concern_id and doctor_id are both nullable, and instant routing needs a specialty BEFORE any doctor is chosen.';

COMMENT ON COLUMN "consultations"."channel" IS 'video or audio call, chosen at booking against the slot doctor_availability offered';

COMMENT ON COLUMN "consultations"."hold_expires_at" IS 'while status = pending_payment this row IS the slot hold; a sweep expires it';

COMMENT ON COLUMN "consultations"."intake_answers" IS 'snapshot of answers to the specialty intake form, including whatever free-text field that form carries. There is no separate patient_note.';

COMMENT ON COLUMN "consultations"."rescheduled_from_consultation_id" IS 'self-reference - the prior consultation this replaced';

COMMENT ON COLUMN "consultations"."followup_pathway_id" IS 'pinned to the pathway version in force when assigned';

COMMENT ON COLUMN "consultations"."followup_status" IS 'cancelled is the state no date arithmetic can produce, which is why this stays';

COMMENT ON COLUMN "consultations"."extra_checkin_questions" IS 'FR-13.8 - DOCTOR-added daily check-in questions for THIS patient only, on top of the pathway set. Carry NO red-flag rules, so safety alerting stays on the clinician-approved set.';

COMMENT ON COLUMN "consultations"."feedback_rating" IS '1 to 5. Set = feedback submitted, so there is no feedback_at.';

COMMENT ON TABLE "consultation_participants" IS 'One row per LiveKit connection, so a reconnect adds a row rather than overwriting one. Call duration is the summed intervals, first join is min(joined_at), and the party with NO row here is the one that did not show - none of the three is stored. Only party = patient and party = doctor are ever written; the CHECK is added by hand in the first migration - see db/README.md.';

COMMENT ON COLUMN "consultation_participants"."livekit_participant_sid" IS 'LiveKit PA_xxx, unique per CONNECTION - this being the key is what makes webhook redelivery idempotent';

COMMENT ON COLUMN "consultation_participants"."consultation_id" IS 'parsed from the room name, which is a function of this id';

COMMENT ON COLUMN "consultation_participants"."joined_at" IS 'participant_joined webhook';

COMMENT ON COLUMN "consultation_participants"."left_at" IS 'participant_left webhook. Null = still connected, or the webhook never arrived';

COMMENT ON COLUMN "consultation_participants"."disconnect_reason" IS 'LiveKit DisconnectReason verbatim (CLIENT_INITIATED, DUPLICATE_IDENTITY, ROOM_DELETED...). Not an enum: LiveKit owns this vocabulary and adds to it. Read when adjudicating a technical_issue complaint or a refund - it is the only thing separating a hang-up from a dropped network.';

COMMENT ON TABLE "instant_consultancy" IS 'One row per doctor offered. Also the source for the FR-18.6 acceptance-rate metric, so no counter is cached on doctors. No responded_at - the acceptance rate counts outcomes, and response latency is not a reported figure.';

COMMENT ON COLUMN "instant_consultancy"."attempt_number" IS 'routing order - 1 is the first doctor tried';

COMMENT ON COLUMN "instant_consultancy"."expires_at" IS 'acceptance window, configured in app_config';

COMMENT ON TABLE "payments" IS 'Becomes paid ONLY on a webhook whose HMAC signature verifies, never on a client result. There is no gateway column: Razorpay is the only one this release integrates, and a constant is not data. No payout_reference: FR-9.9 shows the doctor an amount and a status, and FR-18.4 exports transactions and refunds - no screen prints a bank transfer reference, so the admin who marks a payout paid puts the reference in the metadata of that audit_log row. Only the rounded parts are stored - the figure sent to the gateway is their sum. The unpaid-payout queue reads a partial index added by hand, see db/README.md.';

COMMENT ON COLUMN "payments"."consultation_fee" IS 'frozen at checkout - the doctor keeps all of it';

COMMENT ON COLUMN "payments"."convenience_fee_pct" IS 'the rate in force at checkout. FR-7.3 prints the percentage on the bill, and app_config may have moved on since.';

COMMENT ON COLUMN "payments"."convenience_fee" IS 'stored because rounding must not be recomputed';

COMMENT ON COLUMN "payments"."gst_pct" IS 'same reason as convenience_fee_pct - the bill shows GST at 18 percent';

COMMENT ON COLUMN "payments"."gst_amount" IS 'stored for the same rounding reason';

COMMENT ON COLUMN "payments"."gateway_payment_id" IS 'IDEMPOTENCY - a replayed capture webhook finds this set and no-ops';

COMMENT ON COLUMN "payments"."payment_method" IS 'upi, card, netbanking, wallet - FR-7.1, shown in payment history';

COMMENT ON COLUMN "payments"."refund_initiated_by_admin_id" IS 'refunds are raised from the panel only, FR-7.7';

COMMENT ON COLUMN "payments"."gateway_refund_id" IS 'IDEMPOTENCY - stops a replayed refund webhook double-refunding';

COMMENT ON COLUMN "payments"."payout_paid_at" IS 'NULL until the transfer is made - this IS the payout status. Payouts are manual this release.';

COMMENT ON TABLE "clinical_records" IS 'THE COMPLETION GATE. Setting `finalised_at` requires case_summary, plus
either a medicine line (prescribing specialty) or the advice fields
(non-prescribing). The same transaction clears
doctors.blocked_by_consultation_id. There is no second copy of this
timestamp on the consultation row - it is read through here.

There is no has_clinical_doubt flag. A doubt IS a clarification_cases row
with this source_consultation_id; the flag was a second way of saying the
same thing and could disagree with it.

The doctor pending-summaries worklist is `finalised_at IS NULL`, joined
through consultations on doctor_id. It reads a partial index added by
hand - see db/README.md.
';

COMMENT ON COLUMN "clinical_records"."diagnosis" IS 'diagnosis or provisional diagnosis';

COMMENT ON COLUMN "clinical_records"."referral_note" IS 'set = a referral was advised, and this is it. No separate referral_advised flag.';

COMMENT ON COLUMN "clinical_records"."medicines" IS 'array of - id, name, dose, frequency, duration, instructions, generic_name, route, quantity. id is a client-tracking uuid assigned on save, not a row key - this stays a jsonb array, not a table.';

COMMENT ON COLUMN "clinical_records"."advice_covered" IS 'what was covered this session';

COMMENT ON COLUMN "clinical_records"."advice_warning_signs" IS 'surfaced on the patient Care Plan, FR-14.1';

COMMENT ON COLUMN "clinical_records"."case_summary" IS '3 to 5 lines - required before finalising';

COMMENT ON COLUMN "clinical_records"."recommended_content_ids" IS 'Care Hub items the doctor picked, FR-15.4';

COMMENT ON COLUMN "clinical_records"."finalised_at" IS '*** THE COMPLETION GATE ***  NULL = still a draft. The PDF is the patient_files row with this consultation_id and file_category = prescription_pdf.';

COMMENT ON TABLE "patient_files" IS 'Served only through short-lived signed URLs minted after an ownership check.
No size_bytes and no mime_type: the object store is authoritative for both.
It serves the Content-Type the file was uploaded with, and the preview icon
comes off the file_name extension.

DE-IDENTIFICATION IS STRUCTURAL, not a coding convention. A file attached to
a clarification case is stored as a scrubbed copy with patient_id NULL, so
an expert-facing query cannot reach a patient through it even by mistake:

  CHECK (clarification_case_id IS NULL OR patient_id IS NULL)
';

COMMENT ON COLUMN "patient_files"."patient_id" IS 'set for every clinical file, so history predating any booking is still readable';

COMMENT ON COLUMN "patient_files"."uploaded_by_doctor_id" IS 'set when a doctor uploaded on the patient behalf; NULL means the patient uploaded it themselves';

COMMENT ON COLUMN "patient_files"."consultation_id" IS 'null when the file belongs to the patient rather than one booking';

COMMENT ON COLUMN "patient_files"."report_request_id" IS 'set when uploaded against a doctor request, so it arrives labelled - and so the request is fulfilled without a second timestamp';

COMMENT ON COLUMN "patient_files"."clarification_case_id" IS 'set for a de-identified attachment. When set, patient_id MUST be null - enforced by CHECK, see below.';

COMMENT ON COLUMN "patient_files"."storage_key" IS 'object-store key, never exposed to the client';

COMMENT ON COLUMN "patient_files"."deleted_at" IS 'soft delete. Set = deleted; there is no separate is_deleted flag.';

COMMENT ON TABLE "report_requests" IS 'Patient and doctor are read through the consultation. The treating doctor is always consultations.doctor_id. No fulfilled_at - the arriving patient_files row carries that time in its created_at. No due_by either: no requirement sets a deadline or chases one.';

COMMENT ON COLUMN "report_requests"."title" IS 'what is needed';

COMMENT ON COLUMN "report_requests"."category" IS 'coarse bucket the app filters/groups by. title stays free text for the actual ask.';

COMMENT ON COLUMN "report_requests"."reason" IS 'why - shown to the patient';

COMMENT ON TABLE "followup_pathways" IS 'Admin-editable with no app release, FR-13.7. Versioned whole, so an in-flight assignment keeps the version it started on. No published_at - is_current is what decides which version new assignments get, and when it went live is the audit_log row.';

COMMENT ON COLUMN "followup_pathways"."code" IS 'depression_anxiety, sleep, substance_use, bipolar_psychosis, general';

COMMENT ON COLUMN "followup_pathways"."duration_days" IS 'the follow-up window length. consultations.followup_starts_on plus this IS the end date.';

COMMENT ON COLUMN "followup_pathways"."questions" IS 'ordered question set with the flag rule per option';

COMMENT ON COLUMN "followup_pathways"."red_flag_rules" IS 'conditions forcing a red status, FR-13.5';

COMMENT ON TABLE "checkin_responses" IS 'One row per patient per day. A MISSING row past its date raises a missed_checkin alert. No triggered_rules - answers plus the pinned pathway version reproduce exactly which rules fired, and the alert raised carries the human-readable reason.';

COMMENT ON COLUMN "checkin_responses"."answers" IS 'keyed to the pinned pathway question set';

COMMENT ON TABLE "safety_alerts" IS 'A red status alerts BOTH the treating doctor and admins at care_coordinator or clinical_governance level. There is no status column: open, acknowledged and closed are read from acknowledged_at and closed_at, and the open-alerts queue is a partial index added by hand - see db/README.md.';

COMMENT ON COLUMN "safety_alerts"."reason" IS 'why it fired, in plain words. NEVER names a diagnosis.';

COMMENT ON COLUMN "safety_alerts"."acknowledged_at" IS 'NULL and closed_at NULL = open';

COMMENT ON COLUMN "safety_alerts"."closed_at" IS 'set = closed. These two timestamps ARE the status.';

COMMENT ON TABLE "clarification_cases" IS 'TWO independent checks. seniority_level = expert says WHO MAY BE ASKED. expert_doctor_id says WHAT THEY MAY SEE. Nothing here reaches the patient automatically. No viewed_at and no responded_at - the status enum already carries awaiting_response and response_received, and the expert reply is a messages entry carrying its own `at`.';

COMMENT ON COLUMN "clarification_cases"."source_consultation_id" IS 'for the treating doctor and audit ONLY - never exposed to the reviewer';

COMMENT ON COLUMN "clarification_cases"."topic" IS 'free-text guidance area, e.g. "drug interaction". Not an FR-12.3 field - scanned by the same de-identification pass as title/brief_history.';

COMMENT ON COLUMN "clarification_cases"."expert_doctor_id" IS 'must be a doctor with seniority_level = expert';

COMMENT ON COLUMN "clarification_cases"."assigned_at" IS 'drives the urgency queue. Which admin assigned it is the audit_log row.';

COMMENT ON COLUMN "clarification_cases"."messages" IS 'array of - author_id, author_type, message_type, body, at';

COMMENT ON TABLE "content_items" IS 'No locale - a multilingual app is Phase 3 in SRS section 11, so every row is in the launch language. No published_at - review_status = published says it, and sort_order plus created_at order the shelf. No cover_mime_type - the cover is one admin-uploaded image and the object store types it.';

COMMENT ON COLUMN "content_items"."body" IS 'structured blocks. For item_type = support_org this holds phone, address, timings.';

COMMENT ON COLUMN "content_items"."specialty_id" IS 'used by item_type = clinical_reference';

COMMENT ON COLUMN "content_items"."cover_storage_key" IS 'admin-uploaded cover image. Held as a storage key, NOT a patient_files row - content media is public and has no patient owner, so it must not go through the patient-ownership guard.';

COMMENT ON COLUMN "content_items"."is_verified_org" IS 'item_type = support_org only - has this helpline or NGO been checked. FR-15.6 requires it shown and filtered, so it is a column rather than a key inside body.';

COMMENT ON COLUMN "content_items"."reviewed_by_admin_id" IS 'the clinical reviewer is the client, not the developer';

COMMENT ON TABLE "complaints" IS 'FR-18.8 tracks resolution, so resolved_at stays beside a four-state status - rejected is not resolved, and neither is derivable from the other.';

COMMENT ON COLUMN "complaints"."reference_code" IS 'the ticket number the patient quotes to support';

COMMENT ON COLUMN "complaints"."consultation_id" IS 'null when not about one consultation';

COMMENT ON COLUMN "complaints"."messages" IS 'array of - author_id, author_type, body, is_internal, at';

COMMENT ON TABLE "legal_documents" IS 'No locale - single-language at launch, same as content_items. No published_at - is_current decides what is served, and created_at records when the row was written.';

COMMENT ON COLUMN "legal_documents"."version" IS 'client-set. A new version is a NEW ROW - never edit one people have accepted.';

COMMENT ON COLUMN "legal_documents"."body" IS 'client-supplied copy';

COMMENT ON COLUMN "legal_documents"."is_current" IS 'the version new users must accept';

COMMENT ON TABLE "consents" IS 'No consultation may start without a current teleconsultation consent. Append-only legal evidence.';

COMMENT ON COLUMN "consents"."legal_document_id" IS 'pins the exact version accepted';

COMMENT ON COLUMN "consents"."document_type" IS 'denormalised so the pre-consult check needs no join. A COMPOSITE FK to legal_documents (id, document_type) makes it impossible for this to disagree - see db/README.md.';

COMMENT ON COLUMN "consents"."ip_address" IS 'kept here and nowhere else on an account - this is the legal evidence of acceptance';

COMMENT ON TABLE "data_deletion_requests" IS 'Required by App Store guideline 5.1.1(v) and the DPDP Act. The evidence outlives the data it describes. Deleted and retained were two columns written in the same transaction and always read together, so they are one - and a failed run writes its reason into that same execution_outcome record, so there is no separate failure_reason.';

COMMENT ON COLUMN "data_deletion_requests"."execution_outcome" IS 'one record of what happened - per-table counts deleted or anonymised, what was lawfully retained with the ground for retaining it, or why the run failed. Written once, at execution.';

COMMENT ON COLUMN "notifications"."admin_id" IS 'read in the panel - admins have no push token';

COMMENT ON COLUMN "notifications"."template_code" IS 'booking_confirmed, consult_reminder, doctor_joined, prescription_ready, checkin_due, report_requested, instant_request, red_flag_alert, amber_alert, missed_checkin, pending_documentation, report_uploaded, document_rejected, doctor_approved. A varchar, not an enum - the copy behind each code is an app_config value the admin edits, so adding a code must not need a migration.';

COMMENT ON COLUMN "notifications"."body" IS 'the copy AS SENT. Kept because the template may change later. MUST NOT name a diagnosis, FR-16.2.';

COMMENT ON COLUMN "notifications"."deep_link_data" IS 'deep-link payload';

COMMENT ON COLUMN "notifications"."status" IS 'delivery only. Whether it was READ is read_at.';

COMMENT ON COLUMN "notifications"."read_at" IS 'set = read. There is no read value in the status enum saying the same thing.';

COMMENT ON TABLE "app_config" IS 'Everything the admin can change without a release, as JSON values:
  payments.convenience_fee_pct     payments.gst_pct
  booking.slot_hold_minutes        instant.acceptance_window_seconds
  booking.cancellation_policy      booking.reschedule_policy
  search.crisis_keywords           search.popular_searches
  notifications.templates          retention.policies
  video.join_token_ttl_seconds     video.join_window_minutes

`video.join_window_minutes` is how early before scheduled_start_at the
backend will mint a join token, and `video.join_token_ttl_seconds` is how
long that token stays good. Both are business rules an admin tunes, so
neither is a constant in code. The LiveKit server URL is NOT here - it is
`LIVEKIT_URL` in the environment, one per deployment, and the API key and
secret are environment secrets.

Every change is an audit_log row carrying the actor and the before/after
value, so a config change is reversible without a versions table and
without an updated_by_admin_id that repeats what the log already holds.
Secrets are NEVER stored here.
';

COMMENT ON TABLE "audit_log" IS 'Append-only. Absorbs the login-attempt log (action = login), which is what rate limiting reads, and the credential sign-off trail (action = verify). No summary column - the viewer composes a line from actor_type, action and entity_type, and anything more specific is already in metadata.';

COMMENT ON COLUMN "audit_log"."actor_id" IS 'null for system';

COMMENT ON COLUMN "audit_log"."metadata" IS 'before/after for config, raw payload for webhooks, identifier for login attempts, document id for verification';

ALTER TABLE "doctors" ADD FOREIGN KEY ("verified_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctors" ADD FOREIGN KEY ("specialty_id") REFERENCES "specialties" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctors" ADD FOREIGN KEY ("blocked_by_consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctor_documents" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctor_documents" ADD FOREIGN KEY ("verified_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctor_availability" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctor_regions" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "doctor_regions" ADD FOREIGN KEY ("region_id") REFERENCES "regions" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patients" ADD FOREIGN KEY ("region_id") REFERENCES "regions" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "concerns" ADD FOREIGN KEY ("specialty_id") REFERENCES "specialties" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("specialty_id") REFERENCES "specialties" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("concern_id") REFERENCES "concerns" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("rescheduled_from_consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("followup_pathway_id") REFERENCES "followup_pathways" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultation_participants" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "instant_consultancy" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "instant_consultancy" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("id") REFERENCES "payments" ("consultation_id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "payments" ADD FOREIGN KEY ("refund_initiated_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consultations" ADD FOREIGN KEY ("id") REFERENCES "clinical_records" ("consultation_id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patient_files" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patient_files" ADD FOREIGN KEY ("uploaded_by_doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patient_files" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patient_files" ADD FOREIGN KEY ("report_request_id") REFERENCES "report_requests" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "patient_files" ADD FOREIGN KEY ("clarification_case_id") REFERENCES "clarification_cases" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "report_requests" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "checkin_responses" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "safety_alerts" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "safety_alerts" ADD FOREIGN KEY ("checkin_response_id") REFERENCES "checkin_responses" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "safety_alerts" ADD FOREIGN KEY ("acknowledged_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "safety_alerts" ADD FOREIGN KEY ("acknowledged_by_doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "clarification_cases" ADD FOREIGN KEY ("treating_doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "clarification_cases" ADD FOREIGN KEY ("expert_doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "clarification_cases" ADD FOREIGN KEY ("source_consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content_items" ADD FOREIGN KEY ("concern_id") REFERENCES "concerns" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content_items" ADD FOREIGN KEY ("specialty_id") REFERENCES "specialties" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "content_items" ADD FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "complaints" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "complaints" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "complaints" ADD FOREIGN KEY ("assigned_to_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consents" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consents" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "consents" ADD FOREIGN KEY ("legal_document_id") REFERENCES "legal_documents" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "data_deletion_requests" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "data_deletion_requests" ADD FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "notifications" ADD FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "notifications" ADD FOREIGN KEY ("doctor_id") REFERENCES "doctors" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "notifications" ADD FOREIGN KEY ("admin_id") REFERENCES "admins" ("id") DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE "notifications" ADD FOREIGN KEY ("consultation_id") REFERENCES "consultations" ("id") DEFERRABLE INITIALLY IMMEDIATE;
