# Database Schema

One file: `db/schema.dbml`. **28 tables.**

## Viewing the ERD

1. Open https://dbdiagram.io/d
2. Paste the whole of `db/schema.dbml` into the left editor.

## Three account tables

```
patients   self signup by mobile OTP. Slide owns OTP challenge state. No password, ever.
admins     created by another admin. Email + password. Desktop browser only.
doctors    never self-registers:
             1. admin creates the account       verification_status = pending
             2. doctor uploads papers        ->  doctor_documents
             3. admin approves EACH document     review_status = approved
             4. admin approves the doctor        verification_status = verified
             5. admin lists the doctor           is_listed = true
```

**There is no session table, no `session_*` columns, and no
`refresh_token_hash`.** Revocation is one `token_version smallint` per account
row:

| Question                          | Answered by                                                              |
| --------------------------------- | ------------------------------------------------------------------------ |
| Is this token still valid?        | its `ver` claim equals the row's `token_version`                         |
| When does the login expire?       | the access token's own `exp` claim, and the refresh token's own lifetime |
| Revoke this login                 | `UPDATE ... SET token_version = token_version + 1`                       |
| Sign every device out             | the same one increment                                                   |
| When did they last sign in?       | `audit_log` where `action = 'login'`                                     |
| From what IP, on what user agent? | the same `audit_log` row                                                 |

FR-1.8 (credentials expire and can be revoked) is met by that, in a `smallint`
per account rather than a unique text column plus its index. There is nothing
to look up, nothing to store per sign-in, and no row to clean up.

`push_token` and `device_id` are on `patients` and `doctors` only. FCM delivers
to both iOS and Android, so there is no `push_platform`. **Admins have
neither** - SRS 2.3 puts the panel on a desktop browser, and admin alerts are
read in-panel from `notifications`, which already has an `admin_id` recipient
column.

Patient and doctor OTP codes, expiry and attempt counters are not persisted in
this database; Slide owns that transient challenge state. `mobile_verified_at`
survives on `doctors` only, where it answers a question nothing else can: an
admin types that number in weeks before the doctor first signs in, so null
there means nobody has yet proved they hold it. A `patients` row is only ever
written after Slide confirms the OTP, so on that table the column restated the
existence of its own row; it is gone. Admins authenticate with email and
password, and require a Slide OTP after password verification when
`is_2fa_enabled = true`.

## The spine

`consultations.id` IS the consultation ID:

```
consultations
  |- payments                  1:1  (fee + refund + payout in this row)
  |- clinical_records          1:1  (notes + medicines + case summary)
  |- consultation_participants many (one row per LiveKit connection)
  |- patient_files             many
  |- report_requests           many
  |- checkin_responses         many -> safety_alerts
  |- instant_consultancy       many (routing chain, instant mode only)
  |- complaints                many
  |- notifications             many
```

## The four "documents" tables, and why they are different

| Table              | Holds                   | Editable                     | Read by                   |
| ------------------ | ----------------------- | ---------------------------- | ------------------------- |
| `patient_files`    | files in object storage | no, replace only             | patient + treating doctor |
| `doctor_documents` | credential files        | no, resubmit only            | admins + that doctor      |
| `content_items`    | app screens as jsonb    | yes, constantly              | everyone                  |
| `legal_documents`  | legal text              | **never** - new version only | everyone                  |

`patient_files` was called `documents`. Renamed because the generic name made
it look like it overlapped the other three.

## Redundancy removed

**Derived values are never stored.** Anything computable from stored data is
computed:

| Dropped                                | Because it equals                                             |
| -------------------------------------- | ------------------------------------------------------------- |
| `consultations.scheduled_end_at`       | `scheduled_start_at + duration_minutes`                       |
| `consultations.video_duration_seconds` | summed from `consultation_participants`                       |
| `payments.subtotal`                    | `consultation_fee + convenience_fee`                          |
| `payments.payout_amount`               | `consultation_fee` (deduction is always 0)                    |
| `doctors.active_consultation_id`       | `consultations WHERE doctor_id = me AND status = in_progress` |
| `doctors.instant_requests_offered`     | `count(instant_consultancy)`                                  |
| `doctors.instant_requests_accepted`    | `count(instant_consultancy WHERE accepted)`                   |
| `doctors.consultations_completed`      | `count(consultations WHERE completed)`                        |
| `doctors.no_show_count`                | `count(consultations WHERE no_show)`                          |
| `patients.last_login_at`               | the latest `audit_log` row where `action = 'login'`           |
| `notifications.app_client`             | which recipient column is set                                 |

`convenience_fee` and `gst_amount` ARE stored, deliberately - they carry
rounding that must never be recomputed. So are `convenience_fee_pct` and
`gst_pct`, because FR-7.3 prints the percentage on the bill and `app_config`
may have moved on since that invoice was issued.

**Duplicated facts collapsed to one home:**

| Dropped                                      | Because                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `doctors.status`                             | merged into `verification_status` - both tracked the same lifecycle and both had `pending` and `suspended` |
| `doctors.specialty_ids`                      | the primary was repeated inside the array. One `specialty_id` now                                          |
| `doctors.registration_valid_till`            | already on the registration certificate row                                                                |
| `payments.patient_id` / `.doctor_id`         | 1:1 with a consultation, which already holds both                                                          |
| `clinical_records.patient_id` / `.doctor_id` | same                                                                                                       |
| `consents.version`                           | `legal_document_id` already pins the exact version                                                         |
| `users.role`                                 | each account kind has its own table now                                                                    |
| `users.password_hash`                        | patients authenticate by OTP only                                                                          |

**Unused fields dropped:** `patients.city`/`.state` (SRS asks for name, age,
gender, contact, language - not address), `doctors.city`/`.state`/`.date_of_birth`
(teleconsult, never filtered by location), `content_items.estimated_minutes`.

### The rule applied

A foreign key is repeated on a child ONLY when the child is 1:many from its
parent AND is queried directly by that key. So `report_requests.patient_id`,
`checkin_responses.patient_id` and `safety_alerts.patient_id` stay - those
screens query by patient across consultations. The 1:1 children do not.

### Second-pass audit (27 Aug 2026)

A further redundancy review removed six more columns:

| Dropped                        | Because                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctors.photo_document_id`    | two mechanisms named the same photo - `doctor_documents.document_type = 'profile_photo'` is now the only one, so the photo also goes through credential review |
| `report_requests.patient_id`   | derivable via `consultation_id`                                                                                                                                |
| `report_requests.doctor_id`    | derivable via `consultation_id` - the raiser is always the treating doctor                                                                                     |
| `checkin_responses.patient_id` | derivable via `consultation_id`                                                                                                                                |
| `safety_alerts.patient_id`     | derivable via `consultation_id` (which is NOT NULL)                                                                                                            |
| `safety_alerts.doctor_id`      | same                                                                                                                                                           |

### Third-pass audit (29 Aug 2026)

Session state removed, and every remaining column that restated another one
dropped. Twenty-nine columns and two enums went.

| Dropped                                                                    | Because                                                           |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `session_issued_at` / `_expires_at` / `_revoked_at` / `_revoked_reason` x3 | the login event is an `audit_log` row; expiry is a token claim    |
| `ip_address` / `user_agent` x3                                             | `audit_log` records them per sign-in, not just the latest         |
| `clinical_records.status`                                                  | `finalised_at IS NULL` = draft                                    |
| `payments.payout_status`                                                   | `payout_paid_at IS NULL` = pending                                |
| `patient_files.is_deleted`                                                 | `deleted_at IS NULL` = live                                       |
| `consultations.clinically_completed_at`                                    | `clinical_records.finalised_at`                                   |
| `clinical_records.pdf_file_id`                                             | the `patient_files` row with `file_category = 'prescription_pdf'` |
| `patient_files.uploaded_by_patient_id`                                     | `patient_id` - a patient can only upload their own file           |
| `consultations.livekit_room_name`                                          | a pure function of `consultations.id`                             |
| `consultations.started_at` / `.ended_at`                                   | `greatest()` of the join / leave pair                             |
| `consultations.is_first_consultation`                                      | no earlier consultation exists for this patient                   |
| `payments.total_payable`                                                   | `consultation_fee + convenience_fee + gst_amount`                 |

### Fourth-pass audit - MVP scope (29 Aug 2026)

**Forty-five columns, one enum, one enum value and four foreign keys went. No
table did - still 25.** 360 columns to 315.

The test applied to every column: _is there a flow in MODULES that writes it
and a screen in the SRS that reads it, at launch?_ A column that only answers
"we might want that one day" is a Phase 1.5 migration, not a launch column.

**The session token itself**

| Dropped                            | Replaced by                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `refresh_token_hash` x3            | `token_version smallint` x3 - revoke by incrementing. Three unique text indexes gone; FR-1.8 still met    |
| `push_platform` x3                 | nothing. FCM delivers to both iOS and Android from one token                                              |
| `admins.push_token` / `.device_id` | nothing. SRS 2.3 puts the panel on a desktop browser; admin alerts are `notifications` rows read in-panel |

**Nothing writes it, or nothing reads it**

| Dropped                                                   | Because                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `patients.email`                                          | no requirement names one, and there is no mail transport in the stack. Receipts stay with the gateway                             |
| `patients.emergency_contact_name` / `_phone`              | FR-3.4 and 6.3 _show_ emergency guidance as content. No requirement collects a patient's own contact                              |
| `doctors.email`                                           | doctors sign in by mobile OTP (FR-1.2) and nothing emails them                                                                    |
| `doctors.gender`                                          | FR-4.4 filters on availability, language and fee. Not gender                                                                      |
| `doctors.registration_council`                            | FR-4.2 lists qualification, registration number, experience, languages, fee. Not the council                                      |
| `doctor_documents.expires_on`                             | renewal chasing needs a roster with certificates already expiring; verifying registrations is the client's obligation under SRS 8 |
| `doctor_availability.reason`                              | free text no screen shows                                                                                                         |
| `consultations.patient_note`                              | the specialty `intake_form` carries its own free-text field                                                                       |
| `report_requests.due_by`                                  | no requirement sets a deadline or chases one                                                                                      |
| `instant_consultancy.responded_at`                        | FR-18.6 reports acceptance _rate_, which counts outcomes. Latency is not a reported figure                                        |
| `clarification_cases.viewed_at`                           | open-rate telemetry nobody reports                                                                                                |
| `content_items.locale`, `legal_documents.locale`          | a multilingual app is Phase 3 (SRS 11). Every row is in the launch language                                                       |
| `content_items.cover_mime_type`                           | one admin-uploaded cover image; the object store types it                                                                         |
| `doctor_documents.size_bytes`, `patient_files.size_bytes` | the object store is authoritative and no screen shows a byte count                                                                |
| `payments.gateway`                                        | Razorpay is the only integration this release. A constant is not data                                                             |
| `specialties.default_duration_min`                        | the bookable length is `doctors.consultation_duration_min`. A seed value for an admin form field is not data                      |
| `audit_log.summary`                                       | the viewer composes a line from `actor_type`, `action` and `entity_type`; anything more specific is already in `metadata`         |
| `concerns.patient_facing_label`                           | `name` is the plain-language wording FR-5.4 shows                                                                                 |

**A second copy of what another row already says**

| Dropped                                    | Because it equals                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admins.created_by`, `doctors.created_by`  | the `audit_log` row where `action = 'create'`. Neither is read on every row of a queue, which is the only reason `verified_by_admin_id` survived the same test |
| `clarification_cases.assigned_by_admin_id` | same, on the assignment event                                                                                                                                  |
| `app_config.updated_by_admin_id`           | same. The log already holds actor plus before/after, which is what makes a config change reversible                                                            |
| `clinical_records.has_clinical_doubt`      | a doubt IS a `clarification_cases` row with that `source_consultation_id`. The flag could disagree with it                                                     |
| `checkin_responses.triggered_rules`        | `answers` plus the pinned pathway version reproduce exactly which rules fired                                                                                  |
| `followup_pathways.published_at`           | `is_current` decides what new assignments get; when it went live is the `audit_log` row                                                                        |
| `content_items.published_at`               | `review_status = 'published'` says it; `sort_order` and `created_at` order the shelf                                                                           |
| `legal_documents.published_at`             | `is_current` decides what is served                                                                                                                            |
| `report_requests.fulfilled_at`             | the arriving `patient_files` row carries that time in its `created_at`                                                                                         |

**Computable, so not stored**

| Dropped                              | Because it equals                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `consultations.no_show_party`        | `status = 'no_show'` plus the party with no `consultation_participants` row             |
| `consultations.followup_ends_on`     | `followup_starts_on + followup_pathways.duration_days`, pinned by `followup_pathway_id` |
| `consultations.followup_review_date` | no requirement sets or surfaces a separate review date                                  |
| `consultations.feedback_at`          | `feedback_rating IS NOT NULL` = submitted; the time is the `updated_at` of that write   |

**A flag beside the value that already said it**

| Dropped                             | Replaced by                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinical_records.referral_advised` | `referral_note IS NOT NULL`. Advising a referral without saying what for was never useful                                                   |
| `safety_alerts.status`              | `acknowledged_at` and `closed_at`. Open is both null, acknowledged is the first set, closed is the second. Enum `alert_status` went with it |
| `notification_status.read`          | `notifications.read_at`. The enum now carries delivery only: queued, sent, failed                                                           |

**Two columns always written together and always read together**

| Merged                                                            | Into                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `data_deletion_requests.affected_entities` + `.retained_entities` | `execution_outcome jsonb` - one record written once, at execution |

Kept after challenge:

- **`payments.convenience_fee_pct` / `.gst_pct`** - FR-7.3 prints the rate on
  the bill, and `app_config` may have changed since. Recovering the rate from
  the rounded amount is lossy.
- **`consultations.followup_status`** - `cancelled` is the one state no date
  arithmetic can produce.
- **`complaints.resolved_at`** - FR-18.8 tracks resolution, and `rejected` is
  not `resolved`; neither column derives the other.
- **`consents.ip_address`** - the only IP left outside `audit_log`, because it
  is the legal evidence of acceptance, not a login fact.
- **`doctors.blocked_by_consultation_id`** - the one deliberate cache; instant
  routing checks it on every decision.
- **`doctors.verified_by_admin_id` / `verified_at`** - the approval queue reads these on
  every row and must not join a log.
- **`consultations.specialty_id`** - a booking-time snapshot instant routing
  needs before a doctor exists.
- **`device_id`** - named explicitly by FR-1.8.
- **`clinical_records`' four `advice_*` columns** - the Care Plan renders each
  under its own heading (FR-14.1). Collapsing them to one jsonb would hide four
  labelled fields behind a blob.

### Fifth-pass audit (29 Aug 2026)

Four more columns, each questioned individually. **Still 25 tables. 315
columns to 311.**

| Dropped                            | Because                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patients.mobile_verified_at`      | a patient row cannot exist unverified - sign-up IS the verification, so the column restated its own row. `created_at`, plus the `audit_log` row where `action = 'login'`, carries the time. Kept on `doctors`, where the row predates the first sign-in                 |
| `doctors.last_heartbeat_at`        | presence rides the realtime channel (M-13). The socket already knows who is live: its disconnect handler, and a sweep at boot, write `presence = 'offline'`. A heartbeat column is a row write per online doctor every few seconds for a fact the channel holds already |
| `payments.payout_reference`        | FR-9.9 shows the doctor an amount and a status; FR-18.4 exports transactions and refunds. No screen prints a bank transfer reference. The admin who marks a payout paid puts the reference in that `audit_log` row's `metadata`                                         |
| `clarification_cases.responded_at` | the expert's reply is a `messages` entry carrying its own `at`, and `status = 'response_received'` says it landed. Same argument that dropped `viewed_at`                                                                                                               |

Kept after this pass, with the reason each was challenged on:

- **`token_version`** - it is the whole of revocation. Suspending a doctor,
  deleting a patient, or signing every device out is `token_version + 1`, and
  every live JWT for that account is refused on its next request. Without it a
  suspended account keeps working until its access token expires. FR-1.8 in a
  `smallint`, with no session table and no lookup on the hot path.
- **`doctors.buffer_minutes`** - FR-10.1 names buffer time explicitly. Slot
  generation is `availability - consultations`, stepping by
  `consultation_duration_min + buffer_minutes`; without it back-to-back slots
  are generated and a consult that runs long eats the next one.
- **`doctors.presence`** - FR-10.4 requires seven states, and only three of
  them are derivable. `paused` and `scheduled_only` are choices the doctor
  makes, not facts about consultations.
- **`doctors.is_listed`** - SRS 14 makes verified and listed two separate
  admin actions. Verification is a fact about credentials; listing is a
  merchandising decision, and unlisting a doctor for a week must not throw
  away their approval.
- **`payments.convenience_fee_pct` / `.gst_pct`** - challenged again, kept
  again. FR-7.2 prints the rate on the bill, and back-computing it from the
  rounded amount is lossy: a fee of 333.33 with a 20 percent convenience fee
  rounds to 66.67, which reads back as 20.0012 percent. GST section 8 makes
  the invoice structure a legal artifact confirmed with the client's CA; the
  rate applied to a past invoice must be the rate stored on it, not whatever
  `app_config` holds today.

### Sixth-pass audit (29 Aug 2026)

Seven columns the object store, the file name or a `name` already answered.
**Still 25 tables. 311 columns to 304.**

| Dropped                                                 | Because                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor_documents.mime_type`, `patient_files.mime_type` | the object store is authoritative. It serves the Content-Type the file was uploaded with, and the preview icon comes off the `file_name` extension. Storing it again is a second copy that can disagree with the bytes    |
| `specialties.icon_key`                                  | the app maps `code` to an icon it ships. A specialty added after release shows the default icon until the next build                                                                                                      |
| `specialties.sort_order`, `concerns.sort_order`         | five launch specialties list by name; concerns rank by `match_weight` against the query. Nothing asks for a hand-ordered shelf. `content_items.sort_order` stays - FR-18.7 gives the admin the Care Hub running order     |
| `doctors.verification_note`                             | a rejection is per document (`doctor_documents.rejection_reason`), which is what the doctor must act on. The admin's note on the doctor-level decision is the `metadata` of the `audit_log` row where `action = 'verify'` |
| `data_deletion_requests.failure_reason`                 | `execution_outcome jsonb` is written once at execution and already records what happened; a failed run writes its reason into the same record                                                                             |

There is no `storage_type` column anywhere, and `storage_key` stays on both
file tables - it is the only way a file is located in the object store.

Not redundancy, deliberate:

- Repeated **column shapes** across `patients` / `doctors`, and across
  `doctor_documents` / `patient_files`, are not repeated **data**. No fact is
  stored twice. The tables are separate because the registration flows and the
  access rules genuinely differ.

### LiveKit pass (31 Aug 2026)

The first pass that **adds** a table. **25 tables to 26. 304 columns to 306.**

Three things could have been stored for LiveKit. Two are not.

| Not stored          | Because                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the **room**        | its name is a function of `consultations.id`. One room per consultation is then true by construction - there is no second row that can point at the wrong room, and no reconciliation job                           |
| the **join token**  | it lives for minutes. The backend mints it per request from `LIVEKIT_URL` and the API secret in the environment, and its issue is the `audit_log` row where `action = 'create'` and `entity_type = 'livekit_token'` |
| the **participant** | **stored** - see below                                                                                                                                                                                              |

**`consultation_participants` replaced four columns on the spine.**

`patient_joined_at`, `patient_left_at`, `doctor_joined_at` and `doctor_left_at`
assumed each party connects exactly once. LiveKit does not work that way: it
fires `participant_joined` and `participant_left` per **connection**, and a
phone that loses signal mid-consult produces several of each. Four timestamps
force a choice between overwriting the first join and counting the dead air as
call time, and FR-8.6 makes call duration a stored, reported figure that a
refund and a `technical_issue` complaint both turn on.

```
livekit_participant_sid  varchar(64) PK   LiveKit PA_xxx, unique per connection
consultation_id          uuid             parsed from the room name
party                    party            patient | doctor
joined_at                timestamptz
left_at                  timestamptz
disconnect_reason        varchar(40)      LiveKit DisconnectReason, verbatim
```

Why each column, on the same test every other column here had to pass:

- **The participant sid is the primary key**, not a `bigserial`. LiveKit
  generates it per connection and never reuses it, so a redelivered or
  duplicated webhook collides instead of inserting a second row. Webhook
  idempotency costs zero extra columns and zero extra indexes this way.
- **`party` rather than `patient_id` / `doctor_id`.** Which patient and which
  doctor is already on the consultation row; this table is 1:many from it, so
  repeating either would be the same duplication that dropped
  `payments.patient_id`. The token identity (`patient:<uuid>`) is built from
  the same two facts, so it is not stored either.
- **`disconnect_reason` is `varchar`, not an enum.** LiveKit owns that
  vocabulary and adds values to it; an enum here would need a migration every
  time they do. It is the only thing separating a doctor who hung up from a
  doctor whose network died, which is the question FR-7.7 refunds and
  `complaint_category = 'technical_issue'` are decided on.

Still derived, never stored: call duration (sum the intervals), first join
(`min(joined_at)`), session end (`max(left_at)`), and the no-show party (the
one with no row).

**Config, not schema.** `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` are environment values - one deployment, one server, and
secrets are never in `app_config`. Two tunables are `app_config` keys, because
they are business rules an admin changes without a release:
`video.join_window_minutes` (how early before `scheduled_start_at` a token is
issued) and `video.join_token_ttl_seconds`.

**Nothing was added for the rest of FR-8.** The pre-call camera and microphone
check (FR-8.2) is a client-side permission prompt that stores nothing. Mute and
camera state (FR-8.3) is live track state LiveKit already holds and no screen
reads afterwards. Recording is out of scope for this release (SRS 11), so there
is no egress table.

## Must be added by hand in the first migration

DBML cannot express partial unique indexes, CHECK constraints, composite
foreign keys or GIN indexes. **Without these the schema is not correct.**

```sql
-- 1. Without this, two patients can book the same slot
CREATE UNIQUE INDEX consultations_no_double_booking
  ON consultations (doctor_id, scheduled_start_at)
  WHERE status IN ('pending_payment','scheduled','awaiting_doctor','in_progress');

-- 2. Exactly one recipient/uploader column set where a table is polymorphic
ALTER TABLE notifications  ADD CHECK (num_nonnulls(patient_id, doctor_id, admin_id) = 1);
ALTER TABLE consents       ADD CHECK (num_nonnulls(patient_id, doctor_id) = 1);
ALTER TABLE safety_alerts  ADD CHECK (num_nonnulls(acknowledged_by_admin_id, acknowledged_by_doctor_id) <= 1);

-- 2b. Every patient file has an uploader. A doctor uploader is named; the
--     patient uploader is patient_id itself, so it needs no column.
ALTER TABLE patient_files
  ADD CHECK (uploaded_by_doctor_id IS NOT NULL OR patient_id IS NOT NULL);

-- 3. DE-IDENTIFICATION. A file attached to a clarification case is a scrubbed
--    copy with no patient. This makes FR-12.2 structural, not a coding habit.
ALTER TABLE patient_files
  ADD CHECK (clarification_case_id IS NULL OR patient_id IS NULL);

-- 4. consents.document_type is denormalised for the pre-consult check. This
--    makes it impossible for it to disagree with the document it points at.
ALTER TABLE legal_documents ADD UNIQUE (id, document_type);
ALTER TABLE consents
  ADD FOREIGN KEY (legal_document_id, document_type)
  REFERENCES legal_documents (id, document_type);

-- 5. A refund can never exceed what was charged. The charged total itself is
--    consultation_fee + convenience_fee + gst_amount, computed not stored.
ALTER TABLE payments ADD CHECK (
  refund_amount <= consultation_fee + convenience_fee + gst_amount
);

-- 5b. An alert cannot be closed before it was acknowledged, and cannot be
--     acknowledged by nobody. This is what replaced alert_status.
ALTER TABLE safety_alerts ADD CHECK (
  (acknowledged_at IS NULL) = (num_nonnulls(acknowledged_by_admin_id, acknowledged_by_doctor_id) = 0)
);

-- 6. One approved profile photo per doctor
CREATE UNIQUE INDEX doctor_one_profile_photo
  ON doctor_documents (doctor_id)
  WHERE document_type = 'profile_photo' AND review_status = 'approved';

-- 7. FR-4.4 filters doctor listings by language. Without this it seq-scans.
CREATE INDEX doctors_languages_gin ON doctors USING gin (languages);

-- 8. One generated prescription PDF per consultation. This is what replaced
--    clinical_records.pdf_file_id, so it is the thing keeping it single.
CREATE UNIQUE INDEX patient_files_one_prescription_pdf
  ON patient_files (consultation_id)
  WHERE file_category = 'prescription_pdf' AND deleted_at IS NULL;

-- 9. The worklists that used to be `WHERE status = ...`. Each is now a NULL
--    test, and each needs its own partial index to stay cheap.
CREATE INDEX clinical_records_pending
  ON clinical_records (consultation_id)
  WHERE finalised_at IS NULL;

CREATE INDEX payments_payout_pending
  ON payments (paid_at)
  WHERE payout_paid_at IS NULL AND status = 'paid';

CREATE INDEX patient_files_live
  ON patient_files (patient_id, file_category)
  WHERE deleted_at IS NULL;

-- 9b. The open safety-alert queue, which replaced the (status, alert_type, created_at)
--     index when alert_status was dropped. This is the FR-18.5 governance list.
CREATE INDEX safety_alerts_open
  ON safety_alerts (alert_type, created_at)
  WHERE closed_at IS NULL;

-- 10. Only the two assigned people are ever issued a LiveKit join token, so
--     only those two can appear as participants. `party` is shared with
--     consultations.cancelled_by_party, which legitimately holds all four.
ALTER TABLE consultation_participants
  ADD CHECK (party IN ('patient','doctor'));

-- 10b. "Is the doctor in the call right now?" is read on the consultation
--      room screen and by the status machine on every webhook. Without this
--      it scans every connection the consultation ever had.
CREATE INDEX consultation_participants_live
  ON consultation_participants (consultation_id, party)
  WHERE left_at IS NULL;

-- 11. Exactly one current version per legal document type. `is_current`
--     decides what is served and what new users must accept, so two of them
--     is not a display bug - it is two different texts both claiming to be
--     the one in force, and a consent row could pin either.
CREATE UNIQUE INDEX legal_documents_one_current_per_type
  ON legal_documents (document_type)
  WHERE is_current;
```

`followup_pathways.is_current` and `content_items.review_status = 'published'`
carry the same "one in force" idea but are NOT constrained this way: a pathway
version is pinned onto a consultation at assignment, and the Care Hub shelf is
a list rather than a single document. Only `legal_documents` has to answer
"which exact text is in force right now" with one row.

## Identity: what this database does NOT hold

OTP generation, expiry and attempt state belong to **Slide**. This database keeps
one fact Slide does not hold for us: `doctors.mobile_verified_at`, the moment an
admin-created doctor account was first claimed by the person holding that
number. Patients need no such column - the row is written at verification.

That has one consequence worth stating plainly. FR-1.9 and SRS section 6.1 make
rate limiting the platform's obligation. Since the attempt counter left the
database, the platform's own limit is enforced from `audit_log` where
`action = 'login'`, in addition to whatever Slide applies at their end. Slide's
limits must be confirmed and written into the SRS; until then nobody owns the
gap between the two.

## Names changed for readability (29 Aug 2026)

No column was added or dropped in this pass - each one was renamed to say what
it holds, so a reader who has never opened this file can guess right.

| Was                                                                  | Now                                            | Why                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `patients.mobile_e164`, `doctors.mobile_e164`                        | `mobile_number`                                | E.164 is the storage format, not the meaning. It is now stated in the column note                                           |
| `doctors.doctor_level` (enum `doctor_level`)                         | `seniority_level` (enum `doctor_seniority`)    | `doctors.doctor_level` never said level of what. `seniority_level = 'expert'` reads as the thing it gates                   |
| `doctors.consultation_duration_min`                                  | `consultation_duration_minutes`                | `_min` reads as minimum. It is a unit                                                                                       |
| `doctors.years_experience`                                           | `years_of_experience`                          | reads as English                                                                                                            |
| `doctors.verified_by`, `doctor_documents.verified_by`                | `verified_by_admin_id`                         | it is a foreign key to `admins`, and every other such column already says so                                                |
| `doctor_documents.kind` (enum `doctor_document_kind`)                | `document_type` (enum `doctor_document_type`)  | `kind` alone forces you to read the enum to learn what varies                                                               |
| `doctor_availability.kind` (enum `availability_kind`)                | `rule_type` (enum `availability_rule_type`)    | a row here is a rule - weekly, blocked or custom hours                                                                      |
| `specialties.first_consult_extra`                                    | `first_consult_form`                           | "extra" named its position, not its content. It is a form, beside `intake_form`                                             |
| `consultations.rescheduled_from`                                     | `rescheduled_from_consultation_id`             | a self-referencing FK that did not look like one                                                                            |
| `consultations.cancelled_by`                                         | `cancelled_by_party`                           | it holds patient / doctor / admin / system, not an id. The old name looked like a FK                                        |
| `consultations.followup_extra_questions`                             | `extra_checkin_questions`                      | they are check-in questions, which is where they appear                                                                     |
| `instant_consultancy.sequence`                                       | `attempt_number`                               | `sequence` is a SQL object of a different kind. This is the 1st, 2nd, 3rd doctor tried                                      |
| `payments.method`                                                    | `payment_method`                               | `method` of what, read from a join                                                                                          |
| `payments.refund_initiated_by`                                       | `refund_initiated_by_admin_id`                 | FK to `admins`                                                                                                              |
| `clinical_records.is_provisional`                                    | `is_diagnosis_provisional`                     | provisional what - it qualifies `diagnosis` two lines above                                                                 |
| `patient_files.kind` (enum `patient_file_kind`)                      | `file_category` (enum `patient_file_category`) | it is a clinical category (report, photo, prescription PDF), not a file format - which matters now that `mime_type` is gone |
| `safety_alerts.kind` (enum `alert_kind`)                             | `alert_type` (enum `safety_alert_type`)        | as above                                                                                                                    |
| `safety_alerts.detail`                                               | `reason`                                       | it holds why the alert fired                                                                                                |
| `content_items.kind` (enum `content_kind`)                           | `item_type` (enum `content_item_type`)         | `content_type` was avoided deliberately - it would read as an HTTP Content-Type                                             |
| `content_items.is_verified`                                          | `is_verified_org`                              | verified what. It applies only to `item_type = 'support_org'`                                                               |
| `legal_documents.kind`, `consents.kind` (enum `legal_document_kind`) | `document_type` (enum `legal_document_type`)   | as above                                                                                                                    |
| `data_deletion_requests.outcome`                                     | `execution_outcome`                            | the outcome of the deletion run, not of the request                                                                         |
| `notifications.data`                                                 | `deep_link_data`                               | `data` says nothing                                                                                                         |

Left alone on purpose: `presence` (the standard word for exactly this, and
`availability_*` would collide with the `doctor_availability` schedule),
`buffer_minutes` and `is_listed` (FR-10.1 and SRS 14 use those words),
`blocked_by_consultation_id`, and the four `advice_*` columns, which read as a
group.

## Commands

```bash
npm run db:sql     # schema.dbml -> schema.sql (Postgres DDL)
npm run db:check   # fails on syntax errors or broken references
```

`schema.sql` is generated. Never edit it.

## Rules the schema encodes

- **Completion gate** - setting `clinical_records.finalised_at` is the only
  thing that clears `doctors.blocked_by_consultation_id`. One transaction. The
  consultation keeps no copy of that timestamp; read it through the record.
- **Prescribing** - `clinical_records.medicines` must stay empty unless the
  doctor's specialty has `can_prescribe = true`.
- **Expert visibility** - `doctors.seniority_level = 'expert'` says who may be
  asked; `clarification_cases.expert_doctor_id` says what they may see.
- **Webhook idempotency** - `payments.gateway_payment_id` and
  `.gateway_refund_id` are unique, so a replayed webhook no-ops.
- **Frozen billing** - fee, percentages and the two rounded amounts are stored,
  so changing the fee config cannot rewrite a historical invoice. The charged
  total is their sum, computed at read time.
- **No session, and no session token** - `token_version` is the whole of
  revocation. Every token carries a `ver` claim; a mismatch is refused. Expiry
  is a token claim; who signed in from where is `audit_log`.
- **Consent** - `legal_documents` rows are never edited once accepted; a change
  is a new version row.
- **Follow-up window** - `followup_starts_on` plus the pinned pathway's
  `duration_days`. The daily check-in job reads the pathway, not a second copy
  of the end date.
