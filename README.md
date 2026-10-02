# Coracure Backend

NestJS/Fastify backend for the Coracure consultation platform. One deployable
service, split into domain modules that follow `docs/MODULES 1.md`.

## Local setup

1. Use Node.js 22.13 or newer.
2. Copy `.env.example` to `.env` and replace the development secrets.
3. Start PostgreSQL, Redis and LiveKit with `docker compose up -d`.
4. Apply migrations with `npm run db:migrate`.
5. Seed the first admin and the placeholder legal copy:
   `ADMIN_EMAIL=you@coracure.in ADMIN_PASSWORD=<12+ chars> npm run db:seed`
6. Run `npm run start:dev`.

Local OTP defaults to `OTP_PROVIDER=stub`, which sends nothing and accepts
`OTP_STUB_CODE` (`000000`). Boot refuses to start production with it.

LiveKit has no stub, unlike OTP, storage, push and payments. Those four stand in
for a remote account that does not exist yet; LiveKit is a container in this
repo's compose file, so the local server IS the real one and the same code runs
against it and against AWS. It reads `livekit/livekit.yaml`, whose `devkey` pair
is committed on purpose and refused in production.

The API is served at `http://localhost:3000/api/v1`, Swagger UI at
`http://localhost:3000/docs`, liveness at `/api/v1/health` and readiness
(database reachable) at `/api/v1/health/ready`.

## Quality commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run db:sql      # recompile db/schema.sql from the DBML model
npm run db:seed     # first admin + placeholder legal copy (idempotent)
```

Deployment to EC2 is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Data model

`db/schema.dbml` is the authoritative model for all 28 tables and compiles to
`db/schema.sql`. `prisma/schema.prisma` carries only the tables of the modules
that have been built, and each module adds its own. After editing it:

```bash
npm run db:migrate:dev -- --name <change>   # writes and applies a migration
npm run db:generate                         # refresh the client
```

`prisma/migrations` is applied in order on a clean database by `npm run db:migrate`.

## M-01 Platform Foundation

What every later module is built on.

| Piece                          | Where                                              | Notes                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment, validated at boot | `src/config/env.validation.ts`                     | Every problem is reported at once and the process refuses to start. `env()` is the typed accessor; secrets only ever come from here.                                    |
| Database                       | `src/database/prisma.service.ts`                   | Pooled through the pg driver adapter, proven with a real query at boot, drained on shutdown.                                                                            |
| One error shape                | `src/common/errors.ts`, `http-exception.filter.ts` | `{ statusCode, code, message, details?, path, requestId, timestamp }`. Clients branch on `code`. Nothing internal leaks in production.                                  |
| Role and ownership checks      | `src/common/auth.ts`, `roles.guard.ts`             | `@Roles('patient')` scopes a route, `@CurrentActor()` injects the caller, `assertOwnership()` keeps a user inside their own records. Admin access is never implicit.    |
| Audit trail                    | `src/audit/audit.service.ts`                       | `record()` for the append-only log, `countSince()` for the rate limits M-02 reads from it. A failed write is logged, never thrown.                                      |
| Configuration as data          | `src/app-config/app-config.service.ts`             | `get`/`getOrThrow` validate against the caller's schema, `set` records before/after in the audit log, `seed` installs a module's defaults without overwriting an admin. |
| Events                         | `src/common/event-bus.ts`                          | Modules declare their events by merging into `PlatformEvents` and listen with `@OnEvent`. A failing subscriber never breaks the publisher.                              |

Transport security is environment-owned: TLS terminates at the load balancer
(`TRUST_PROXY=true` so the client IP in the audit log is real), the database
connection requests TLS through `?sslmode=require` on `DATABASE_URL`, and
storage encryption at rest is a property of the managed database and bucket.

Note: SRS section 7 names Drizzle ORM; this build uses Prisma, which needs a
revision line in the SRS.

## M-02 Identity and Access

Owns `patients` and `admins`, and authenticates all three account kinds. The
`doctors` row belongs to M-05, which holds the registration and verification
state this module's doctor branch reads.

| Piece           | Where                                      | Notes                                                                                                                                                      |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens          | `src/identity/tokens.service.ts`           | Access and refresh share one secret and are separated by a mandatory audience plus a `kind` claim, so neither can pass as the other.                       |
| Revocation      | `src/identity/accounts.service.ts`         | The `ver` claim is compared with the row's `token_version`. One increment refuses every token on every device. No session table, no stored token.          |
| Authentication  | `src/identity/auth.guard.ts`               | Deny by default - a route is protected unless it carries `@Public()`. Runs before `RolesGuard`, which is why `IdentityModule` is imported first.           |
| Patient sign-in | `src/identity/patient-auth.service.ts`     | Sign-up and sign-in are one flow. The first correct code writes the row, which is why `patients` has no `mobile_verified_at`.                              |
| Admin sign-in   | `src/identity/admin-auth.service.ts`       | Argon2id, plus a Slide OTP second leg when `is_2fa_enabled`. An unknown address is verified against a decoy hash so sign-in timing does not reveal it.     |
| Rate limiting   | `src/identity/login-rate-limit.service.ts` | FR-1.9, counted from `audit_log` where `action = 'login'`, per identifier. No counter column, so a restart cannot reset a limit. Editable in `app_config`. |
| OTP             | `src/identity/otp/`                        | Slide behind an `OtpProvider` port. **Its request and response shapes are provisional** - SRS 3.3 records the contract as unconfirmed.                     |

### Endpoints

```
POST /auth/patient/otp/request     public   send a sign-in code
POST /auth/patient/otp/verify      public   code -> tokens, creating the account on first use
POST /auth/doctor/otp/request      public   send a sign-in code; the account must already exist
POST /auth/doctor/otp/verify       public   code -> tokens + verificationStatus
POST /auth/admin/sign-in           public   email + password, may return status: two_factor_required
POST /auth/admin/two-factor        public   mfaToken + code -> tokens
POST /auth/refresh                 public   refresh token -> a new pair
POST /auth/sign-out                bearer   *** signs out of EVERY device ***
POST /auth/admin/accounts          bearer   super_admin only; there is no admin self sign-up
```

Sign-out ends every session for that account, because revocation is one
`token_version` increment and there is nothing per-device to end. Push
delivery stops with it (FR-1.8).

### Known gaps

- Slide's API contract and its own rate limits are unconfirmed (SRS 3.3).
  Everything provider-specific is in `src/identity/otp/slide.provider.ts`;
  confirming the contract should change no other file.
- A patient row is created `pending` and stays there until M-04 completes the
  profile. Both `pending` and `active` may sign in; only `suspended` and
  `deleted` are refused.

## M-03 Consent and Legal

Owns `legal_documents`, `consents` and `data_deletion_requests`.

| Piece                | Where                                  | Notes                                                                                                                                                                       |
| -------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned legal copy | `src/legal/legal-documents.service.ts` | A version is a ROW. Publishing inserts and demotes the previous current row in one transaction; nothing is ever edited, so an old consent still resolves to its exact text. |
| Consent evidence     | `src/legal/consents.service.ts`        | Append-only. The client names a document TYPE, never a version, so it cannot accept a superseded one. The IP is kept here and nowhere else on an account.                   |
| The pre-consult gate | `assertTeleconsultationConsent()`      | SRS 6.2 / FR-2.3. A method, not a column, so M-11 and M-14 share one implementation of the rule.                                                                            |
| Data deletion        | `src/legal/data-deletion.service.ts`   | FR-2.5, App Store 5.1.1(v), DPDP. M-03 owns the request and its evidence; M-21 runs the deletion and calls `recordExecution`.                                               |

### Endpoints

```
GET  /legal/documents                              public   current documents, without bodies
GET  /legal/documents/:type                        public   full text of the current version
POST /legal/consents                               bearer   accept the current version of a type
GET  /legal/consents/me                            bearer   what I have accepted, and which version
GET  /legal/consents/me/status                     bearer   have I accepted the CURRENT version of each
POST /me/deletion-requests                         patient  ask for my data to be deleted
GET  /me/deletion-requests                         patient  my requests and their status
POST /admin/legal/documents                        admin    publish a new version (content / clinical_governance)
GET  /admin/legal/documents/:type/versions         admin    full version history
GET  /admin/deletion-requests                      admin    the queue, oldest first (operations)
POST /admin/deletion-requests/:id/review           admin    in_review / approved / rejected (operations)
```

The legal documents are public on purpose: FR-2.4 puts the privacy policy and
terms in the app, and store review reaches them before anyone has an account.

### Rules the schema enforces, not the code

Three constraints in the migration carry rules that would otherwise be a coding
habit:

- `CHECK (num_nonnulls(patient_id, doctor_id) = 1)` — a consent belongs to
  exactly one person.
- A composite foreign key on `(legal_document_id, document_type)` makes the
  denormalised `document_type` unable to disagree with the document it points
  at. The column exists so the pre-consult check needs no join.
- A partial unique index on `document_type WHERE is_current` — two current
  versions is not a display bug, it is two texts both claiming to be in force.

### Known gaps

- Approving a deletion request authorises the run but deletes nothing.
  `recordExecution` is where M-21's run reports back.

## M-04 Patient Profile

Owns **no table**. The profile is columns on the `patients` row M-02 owns; this
module is the read and edit interface every other module goes through.

| Piece               | Where                                     | Notes                                                                                                                                                     |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Age                 | `src/patients/date-of-birth.ts`           | Derived on every read, never stored — FR-2.2 asks for age, but an age column is wrong again on every birthday. All UTC, so a calendar day does not shift. |
| Profile read / edit | `src/patients/patient-profile.service.ts` | Partial edits. `mobileNumber` is absent from the DTO: it is the sign-in identifier, and changing it is an OTP re-verification flow nothing asks for.      |
| Account promotion   | same                                      | A name **and** a date of birth move the account `pending` → `active`. Nothing else does, which is why it lives here and not in M-02.                      |
| Doctor's view       | `getCardForDoctor()`                      | FR-9.2: initials, age and gender — never the name. Gated on assignment (SRS 6.2).                                                                         |
| Language and region | `regionId`, `preferredLanguage`           | **The two fields assignment matches on (FR-20.10).** Language is never relaxed; region is a preference. A retired region is refused as a preference.      |

### Endpoints

```
GET   /me/profile              patient  my profile, with derived age and isComplete
PATCH /me/profile              patient  partial edit; completing it activates the account
                                        `regionId` and `preferredLanguage` are what assignment matches on
GET   /patients/:id/card       doctor   initials + age + gender, only if treating them
```

### The assignment gate fails closed

"A doctor sees only assigned patients" (SRS 6.2) is answered from
`consultations`, which M-11 owns and which does not exist yet. Rather than
leave the rule unwritten, `PATIENT_ASSIGNMENT` is a port with
`DenyAllPatientAssignment` behind it — **every doctor is refused until M-11
supplies the real lookup.** An access rule that is not implemented yet must
refuse, not allow. Both branches are covered by tests that inject a stub.

### Known gaps

- The doctor card route can now be signed into (M-05 mints doctor tokens) but
  still refuses everyone, because `DenyAllPatientAssignment` is what answers
  until M-11 exists. Both branches are unit-tested.
- `preferredLanguage` accepts `en` and `hi`. Launch is single-language
  (SRS 11 defers a multilingual app to Phase 3), but FR-4.4 filters doctors by
  language, so the value is constrained rather than free text.

## M-05 Doctor Registry and Verification

Owns `doctors` and `doctor_documents`. A doctor **never** self-registers
(FR-1.2). Five steps, and each one is a separate deliberate act:

```
1. an admin creates the account        verification_status = pending
2. the doctor uploads credentials  ->  doctor_documents, status = under_review
3. an admin approves EACH document     review_status = approved, reviewer on the row
4. an admin verifies the doctor        verification_status = verified
5. an admin lists the doctor           is_listed = true
```

| Piece                      | Where                                        | Notes                                                                                                                                                              |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The account and the roster | `src/doctors/doctor-registry.service.ts`     | Profile, fee, instant permission, expert level, listing, suspension. Suspension is a STATE — the row is referenced by consultations that must outlive the account. |
| Per-credential approval    | `src/doctors/doctor-verification.service.ts` | Each document is approved or rejected on its own with a reason, and a decision is final. A rejected credential is replaced by a new upload, never edited.          |
| The doctor-experience gate | `src/doctors/doctor-access.ts`               | `@VerifiedDoctorsOnly()` reads the ROW, not the token, so revoking approval bites on the very next request. M-07 onward put it on their doctor routes.             |
| Credential files           | `src/doctors/credential-storage.ts`          | Signed URLs both ways; bytes never cross this service. The key is minted from the doctor's own id, and `storage_key` is never returned to any client.              |
| Region pools               | `setRegions()`                               | Which states this provider serves. Replaced whole in one transaction, so a half-applied edit cannot leave them in a region they were being taken out of.           |
| Sign-in                    | `src/identity/doctor-auth.service.ts`        | Mobile OTP, the same as a patient's, but with no sign-up: an unknown number is refused rather than texted a code.                                                  |

### Endpoints

```
GET   /me/doctor/profile                       doctor   my profile, verification status and isBookable
PATCH /me/doctor/profile                       doctor   bio, languages, duration, buffer - never my own fee
GET   /me/doctor/credentials                   doctor   my documents, and what is still outstanding
POST  /me/doctor/credentials/upload-url        doctor   a signed URL to PUT the file to
POST  /me/doctor/credentials                   doctor   record the upload; the first one moves me to under_review
GET   /doctor-credentials/:id/download-url     either   doctor-owner or admin; expires in minutes, and is audited
GET   /doctors/:id                             patient  the provider ASSIGNED to me (FR-4.3); 404 for anyone else

GET   /admin/doctors/:id/regions               admin    the region pool this provider serves
PATCH /admin/doctors/:id/regions               admin    set that pool, whole (FR-18.9)

POST  /admin/doctors                           admin    create the account (operations)
GET   /admin/doctors                           admin    the roster, in every state
GET   /admin/doctors/credential-queue          admin    documents waiting on a decision, oldest first
GET   /admin/doctors/:id                       admin    one doctor in full
GET   /admin/doctors/:id/reliability           admin    FR-18.6, counted not stored - null until M-11 and M-13
PATCH /admin/doctors/:id                       admin    profile, fee, instant permission (operations)
GET   /admin/doctors/:id/credentials           admin    their documents and what is outstanding
POST  /admin/doctors/credentials/:id/review    admin    approve or reject ONE document (clinical_governance)
POST  /admin/doctors/:id/verify                admin    step 4; refused while anything is outstanding
POST  /admin/doctors/:id/reject                admin    turn the application down
POST  /admin/doctors/:id/reopen                admin    let a rejected doctor try again
PATCH /admin/doctors/:id/listing               admin    step 5; refused unless verified
PATCH /admin/doctors/:id/seniority             admin    grant or revoke expert level (FR-1.6)
POST  /admin/doctors/:id/suspend               admin    delists and signs them out everywhere
POST  /admin/doctors/:id/reinstate             admin    lifts the suspension, but does NOT relist
```

Doctor management is split across two permission levels: `operations` runs the
roster and the money, `clinical_governance` judges credentials. The person who
sets a fee is not, by default, the person who decides a registration certificate
is genuine. `super_admin` passes both.

### An unverified doctor can sign in, and that is the point

The gate cannot be at sign-in: steps 2 and 3 need the doctor logged in, to
upload papers and read what was rejected. So `pending` and `under_review` sign
in and reach exactly two things — their own profile and their own credentials.
Everything that is part of consulting carries `@VerifiedDoctorsOnly()`.
`rejected` and `suspended` cannot sign in at all, and suspension has already
bumped `token_version`, so any token they still hold is dead too.

### Rules the schema enforces, not the code

- `CHECK (is_listed = false OR verification_status = 'verified')` — **the
  listing rule**. No query, no admin action and no later module can put an
  unverified doctor in front of a patient.
- `CHECK (review_status <> 'rejected' OR rejection_reason IS NOT NULL)` — a
  rejection with no reason is an unanswerable support ticket for the doctor who
  receives it.
- A reviewed document must name its reviewer and the time; a pending one must
  name neither.
- `CHECK (verification_status <> 'verified' OR (verified_by_admin_id IS NOT NULL
AND verified_at IS NOT NULL))` — SRS section 8 puts doctor verification on the
  client, and this is the evidence that it happened, with who did it.
- `CHECK (jsonb_typeof(languages) = 'array')`, plus a GIN index — FR-4.4 filters
  on `languages`, and a value stored as an object would be silently invisible to
  every filter.

### Three ports, all of them failing closed

| Port                  | Answered later by | Until then                                                                                                                      |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SPECIALTY_CATALOGUE` | M-06              | required documents are the `app_config` baseline (degree, registration, identity), and `canPrescribe` is **false for everyone** |
| `DOCTOR_METRICS`      | M-11, M-13        | every rate is `null`, never `0` — a doctor who has been offered nothing has not failed to accept anything                       |
| `CREDENTIAL_STORAGE`  | the environment   | `STORAGE_PROVIDER=stub` signs URLs that go nowhere; production refuses to boot with it                                          |

The baseline requirement list is why `readyForVerification` is never trivially
true. An empty requirement list would let an admin sign off a doctor who has
uploaded nothing, which is the one outcome SRS section 8 cannot tolerate.

### Changed by SRS 1.2

- **The patient directory is gone.** `GET /doctors` with its filters and
  sort-by-fee contradicted FR-4.2 once the patient stopped choosing a provider.
  What is left is `GET /doctors/:id`, gated on M-04's assignment port, so a
  patient sees the profile of the provider assigned to them and nobody else.
- **`consultationFeeInr` split into two numbers.** `payoutFeeInr` on the
  provider is what they are paid; what the patient is charged is the specialty
  fee (M-06). A patient who cannot choose their provider has to be quoted
  before one is assigned.
- **Region pools.** `doctor_regions` is M-05's, pointing at M-06's `regions` —
  the same split as `doctors.specialty_id` and `specialties`.

### Known gaps

- `blocked_by_consultation_id` has no foreign key yet; M-11 adds it with
  `consultations`.
- Live availability is missing from the directory, which FR-4.2 asks for. Slots
  are computed by M-07 from `doctor_availability`, which does not exist yet.
- `presence` is read but never written here. M-13 owns the seven doctor states
  (FR-10.4) and carries them on the realtime channel.
- The `stub` credential storage signs a URL with no object store behind it, so
  locally the row is written but the bytes are not. The whole review flow still
  runs; only the file is missing.
- **The migration has not been applied to a live database here** — Docker was
  not running in this environment. `npm run db:migrate` on a clean database is
  the check still outstanding.

## M-06 Catalogue, Specialty and Allocation Configuration

Owns `specialties`, `concerns` and `regions` — everything assignment matches
against. Adding a service, a concern or a region is an admin action: no code
change, no app release (FR-19.1, FR-19.8).

This is also the module that answers M-05's `SPECIALTY_CATALOGUE` port. M-05 was
built first and declared the port with a conservative default; M-06 owns the
data, so M-06 binds it.

| Piece                  | Where                                          | Notes                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services               | `src/catalogue/specialties.service.ts`         | One row per service. Carries the price the patient is quoted, the registration form its providers use, the prescribing right, the intake forms, and the credentials M-05 demands. |
| Concerns               | `src/catalogue/concerns.service.ts`            | The taxonomy symptom search maps onto. Since SRS 1.2 a search resolves to a concern and its service — never a shortlist of people.                                                |
| Regions                | `src/catalogue/regions.service.ts`             | States or provinces, as rows. Disabling one is refused while providers still serve it.                                                                                            |
| Allocation policy      | `src/catalogue/allocation-policy.service.ts`   | How ties are broken, whether region may be relaxed, how many declines a patient gets. An `app_config` value, so the client changes it without a release.                          |
| The port M-05 declared | `src/catalogue/specialty-catalogue.adapter.ts` | `requiredDocuments`, `canPrescribe` and `patientFeeInr`, read from the specialty row.                                                                                             |

### Endpoints

```
GET   /services                        any     the services a patient can book (FR-4.1)
GET   /concerns                        any     the concern taxonomy (FR-5.2)
GET   /regions                         any     what a patient picks in their profile (FR-20.10)

GET   /admin/specialties               admin   every specialty, active or not
GET   /admin/specialties/:id           admin   one, with its forms and credential list
POST  /admin/specialties               admin   add a service (content / clinical_governance)
PATCH /admin/specialties/:id           admin   edit it; a fee change applies to the next booking
GET   /admin/concerns                  admin   every concern, including disabled
POST  /admin/concerns                  admin   add one with its match phrases (FR-5.7)
PATCH /admin/concerns/:id              admin   edit phrases, weight or status
GET   /admin/regions                   admin   every region
POST  /admin/regions                   admin   add a region (content / operations)
PATCH /admin/regions/:id               admin   rename or disable it
GET   /admin/allocation-policy         admin   how providers are allocated (SRS 4.20)
PATCH /admin/allocation-policy         admin   change it (operations)
```

### The two registration forms live on the specialty

`providerType` is `doctor` or `non_doctor`, and it sits on the **specialty**,
never on the provider (FR-19.7). The specialty already decided the required
credential list and the prescribing right, so a second copy on the provider row
is a fact with two homes that can disagree. It also means M-05 needed no new
column and no new branch — it already asks the specialty what to demand.

The form decides **three** things, and one column answers all three so they can
never drift apart:

| The form decides                                              | Where it bites                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Which credentials must be submitted                           | M-05 verification: `requiredDocuments` is the baseline plus the specialty's |
| Whether the specialty may prescribe                           | A CHECK constraint, and `canPrescribe` on the assigned provider             |
| Whether a **medical council registration number** is required | M-05 verification refuses a doctor-form provider without one                |

That last one is why `requiresRegistrationNumber` is on the `SPECIALTY_CATALOGUE`
port. A psychologist, therapist or counsellor holds no council registration, so
demanding one would make the non-doctor form impossible to complete; a
psychiatrist without one must not be signed off, because SRS section 8 makes
confirming medical registration before listing the client's own obligation and a
platform that let it through would be quietly working against them.

```
POST /admin/doctors/:id/verify        # doctor-form provider, no council number
409 CREDENTIALS_INCOMPLETE
This provider's specialty uses the doctor registration form, so a medical
council registration number is required before they can be verified (FR-19.7).
```

It is reported separately from the document list, and named as a profile field:
an admin told only "credentials outstanding" would go hunting through uploads
for something that was never going to be there.

### The baseline is a floor, not a default

`requiredDocuments` returns the **union** of the platform baseline (degree,
registration, identity — an `app_config` value) and whatever the specialty adds.
A specialty created with an empty list would otherwise make verification
trivially satisfiable, and an admin could sign off a provider who had uploaded
nothing. The admin form can only ever ask for **more**.

### Rules the schema enforces, not the code

- `CHECK (can_prescribe = false OR provider_type = 'doctor')` — **only a doctor
  specialty prescribes.** This is the line between a psychiatrist and a
  psychologist (SRS 4.3), and it is too important to leave to an admin form.
- `jsonb_typeof(required_documents) = 'array'` and the same for
  `match_phrases` — stored as an object, neither would error anywhere:
  verification would silently require nothing and a concern would silently match
  nothing.
- `consultation_fee_inr >= 0`, and the `doctors.specialty_id` foreign key M-05
  left open, with `ON DELETE RESTRICT` — deleting a service that providers are
  registered under would take the providers with it. A service leaves by
  `is_active = false`.

### Allocation policy, and what it deliberately cannot do

```json
{ "regionRelaxable": true, "tieBreak": "fewest_upcoming", "maxPatientDeclines": 2 }
```

There is **no setting that relaxes language**. FR-20.4 makes it a hard
requirement: a provider who cannot speak to the patient is never assigned to
them, and that is not an admin's to change. Region bends; language does not.
`fewest_upcoming` is the load-balancing default — work spreads across the pool
rather than landing on whoever sorts first.

### Known gaps

- **Nothing consumes the policy yet.** M-06 owns and validates it; M-11 makes
  the assignment and M-13 re-routes by calling the same resolution. Until then
  it is configuration with no reader.
- Specialties, concerns and regions all ship **empty**. `npm run db:seed` does
  not create them: what services the client offers, at what price, in which
  states, is theirs to decide, and a guessed psychiatry row at a guessed fee is
  worse than an empty table.
- Prescription and therapy-plan templates are deferred (SRS 11).
- ~~The migration has not been applied to a live database.~~ **Closed while
  building M-07, and re-checked for every module since.** `prisma migrate deploy`
  runs clean on an empty database through all eight migrations, and `prisma
migrate diff` reports no drift on any table M-07 onwards touches. The differences it does report on `consents`, `doctors`
  and `legal_documents` are the hand-written composite key, GIN index and
  `ON DELETE RESTRICT` that the Prisma model cannot express, and are expected.

## M-07 Availability and Scheduling

Owns `doctor_availability` — one table covering the weekly pattern, blocked
dates, leave and date overrides. It decides when each provider can be booked,
and it is the module that can answer FR-10.7: **how long is this provider free
for, from this moment.**

| Piece                   | Where                                    | Notes                                                                                                                                                                  |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The rules               | `src/scheduling/availability.service.ts` | The only writer of `doctor_availability`. A provider and an admin go through the same methods, and the audit entry names whose diary it was as well as who changed it. |
| What they add up to     | `src/scheduling/scheduling.service.ts`   | Free time, slots, remaining duration, and the conflict guard. Computes; stores nothing.                                                                                |
| Interval algebra        | `src/scheduling/intervals.ts`            | Blocks, leave, breaks and bookings are all the same subtraction. Pure, so every edge is testable without a clock or a database.                                        |
| Wall clock to instants  | `src/scheduling/local-time.ts`           | A diary is local time, a consultation is an instant. `PLATFORM_TIMEZONE` is the one zone that connects them.                                                           |
| The port M-11 will bind | `src/scheduling/booked-intervals.ts`     | What time is already taken. `consultations` does not exist yet, so this returns nothing and M-11 binds the real reader.                                                |

### Endpoints

```
GET    /me/doctor/availability                        doctor  my pattern, leave and overrides
PUT    /me/doctor/availability/weekly                 doctor  replace the WHOLE weekly pattern
POST   /me/doctor/availability/blocked                doctor  a day of leave, or a gap in one
POST   /me/doctor/availability/custom-hours           doctor  different hours for one date
DELETE /me/doctor/availability/:ruleId                doctor  remove a rule
GET    /me/doctor/slots?from&to                       doctor  what my rules actually offer

GET    /admin/doctors/:id/availability                admin   a provider's diary
PUT    /admin/doctors/:id/availability/weekly         admin   replace their pattern (FR-10.1)
POST   /admin/doctors/:id/availability/blocked        admin   take an absent provider out of the pool
POST   /admin/doctors/:id/availability/custom-hours   admin   override one date
DELETE /admin/doctors/:id/availability/:ruleId        admin   remove one of their rules
GET    /admin/doctors/:id/slots?from&to               admin   what they are offering
GET    /admin/availability/remaining                  admin   who is assignable for a service,
                                                              language, region and time (FR-18.9)
```

Every provider route carries `@VerifiedDoctorsOnly()`. Setting availability is
the act of offering to see patients, so it sits behind the same door as the rest
of the provider experience — and an account an admin has not approved has
nothing to offer.

**There is no patient-facing route here, on purpose.** Since SRS 1.3 the patient
picks a service and a time, never a person, so "which slots can this service
cover" is assignment's question and belongs to M-11. What M-07 publishes to the
rest of the platform is `SchedulingService`, not an endpoint.

### There is no slots table

Bookable slots are **computed** every time: the provider's hours, minus blocks
and leave, minus what is already booked. A generated slots table would be a
second copy of all three, it would need a horizon nobody can pick, and every
diary edit and every cancellation would have to rewrite it. The one thing worse
than computing this on demand is showing a patient a slot that a stale row says
is free.

### The rule engine, in precedence order

For each local date:

1. a whole-day `blocked` row removes the date outright — **leave beats
   everything**, which is why an admin blocking an absent provider never has to
   find and edit the rule that made them available;
2. `custom_hours` for that date **replace** the weekly pattern rather than
   adding to it. "On the 14th I work 14:00 to 18:00" means instead of the usual
   Monday; added to it, the provider would still be bookable at 09:30 on a day
   they had cleared;
3. otherwise the weekly rows for that weekday apply;
4. partial blocks are subtracted from whichever won, then existing bookings are.

Runs that touch are merged **across dates**, so a 22:00–24:00 Monday and a
00:00–02:00 Tuesday are one unbroken four-hour run. Counted as two, FR-10.7
would refuse a long booking at 23:45 that the provider can perfectly well take.

### Duration, not just a start time (FR-10.7)

```
GET /admin/availability/remaining?at=2026-09-14T09:30:00Z&specialtyId=…&language=hi&regionId=…
→ [{ doctorId, fullName, availableMinutes: 10, requiredMinutes: 35, assignable: false }]
```

The filter takes the same inputs assignment does (FR-20.2): **service, language,
region and time**. Language especially — FR-20.4 never relaxes it, so a panel
that could not filter on it would offer an admin providers who cannot speak to
that patient. Region can be left off, because FR-20.5 lets the policy relax it.

This is the whole reason the module exists. A provider free at 15:00 and booked
at 15:10 is **not** assignable to a thirty-minute consultation, and a system
that asked only "free at 15:00?" would have the patient and the provider
discover the collision in the video room. `availableMinutes` is the _unbroken_
run from that moment; `requiredMinutes` is duration **plus buffer**, because the
buffer is time the provider owes and cannot sell. `assignable` also folds in
verification and listing — an open diary does not make an unlisted provider
bookable.

M-11 and M-13 call the same computation through `assignableAt()` to filter a
pool; the endpoint above is FR-10.7's admin view, sorted longest run first,
which is how an admin checks an allocation before overriding it.

### Two patients cannot take the same slot

`assertFree()` is the check M-11 makes inside the transaction that writes a
consultation: the whole of duration + buffer must sit inside **one** free run,
not spread across two windows with a booking or a break between them.

It is the first of two locks, not the only one. A check and a write are two
statements, and two requests can both pass the check before either writes. The
last word is the partial unique index on
`consultations (doctor_id, scheduled_start_at)` for live statuses, which M-11
adds with the table. This guard is what turns that collision into a clear
`SLOT_UNAVAILABLE` instead of a constraint violation, and what catches the far
commoner case of a slot that was never offered at all.

### Rules the schema enforces, not the code

Each of these is also applied in the service. They are repeated in the migration
because a half-written rule does not fail loudly — it quietly widens or narrows
when a provider can be booked, and nobody finds out until a patient is sitting
in an empty video room. All four were exercised against a live database.

- `doctor_availability_shape` — **which columns each rule type owns.** A
  `weekly` row with no weekday applies to no day at all; a `custom_hours` row
  with no times would silently erase that date's hours; a `blocked` row with one
  of its two times is ambiguous between "from 13:00" and "until 13:00".
- `day_of_week BETWEEN 0 AND 6` — a smallint would otherwise accept 9.
- `start_time < end_time` — equal times are refused too. A zero-length window is
  not a shorter working day, it is a row that means nothing.
- The foreign key is `ON DELETE CASCADE`, the opposite of
  `doctors.specialty_id`: a diary describes one provider and has no meaning
  without them, whereas a specialty is a shared catalogue row.

### One time zone, named in the environment

`PLATFORM_TIMEZONE` (default `Asia/Kolkata`) is the wall clock every diary is
written in. `doctor_availability` stores a weekday and a local time,
`consultations.scheduled_start_at` stores an instant, and nothing moves between
them without a zone. One deployment serves one country, so it is one setting
rather than a column on every provider — the same reasoning that keeps LiveKit
to one `LIVEKIT_URL`. The conversion applies the offset twice, so a deployment
in a zone that observes daylight saving is not an hour out for half the year.

One consequence worth knowing about: Postgres accepts `24:00:00` for a window
that runs to midnight, and the driver hands it back as **the following day**.
Read naively it comes out as `00:00` and erases a provider's whole evening,
which is why `minutesFromTimeColumn` counts the day rollover. This was confirmed
against a live database, not assumed.

The **write** side of the same value bit later, during M-11: Prisma serialises a
`time` from a JS Date's time-of-day only, so 1440 minutes went in as `00:00:00`
and tripped the `start_time < end_time` CHECK — every weekly pattern ending at
midnight failed to save. Availability writes now pass the times as SQL literals
for that reason; everything else stays Prisma.

### Known gaps

- **Nothing is booked yet.** `BOOKED_INTERVALS` returns an empty map because
  `consultations` arrives with M-11. That is the honest answer rather than an
  optimistic one — there are genuinely no bookings to collide with — but it does
  mean the conflict prevention has nothing to prevent in this build. The
  algorithm is tested against injected intervals instead, and M-11 binds the
  real reader over the token without M-07 changing.
- **Instant consultation is not scheduling.** FR-10.2 to FR-10.6 — the seven
  doctor states, the acceptance window, the completion gate — are M-13's. M-07
  answers only "when is this provider free", which is what instant routing will
  ask it.
- Availability is **not seeded**. A provider's hours are theirs to set, and a
  guessed 9-to-5 would make an unstaffed diary look staffed.

## M-08 Notifications

Owns `notifications` — one row per recipient, with exactly one of `patient_id`,
`doctor_id` and `admin_id` set. Every module from M-11 on raises notifications
through it, and none of them knows what a device token is.

| Piece                   | Where                                         | Notes                                                                                                           |
| ----------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| What other modules call | `src/notifications/notifications.service.ts`  | `notify()` and `notifyAdmins()`. Never throws — a booking is not undone because a reminder could not be worded. |
| The copy                | `src/notifications/templates.service.ts`      | Reads, renders and edits the wording, and enforces FR-16.2 on both.                                             |
| The catalogue           | `src/notifications/notification-templates.ts` | The 14 codes, who each may be addressed to, and the complete list of variables copy may use.                    |
| The delivery seam       | `src/notifications/push/push.provider.ts`     | The port. Above it, nobody knows delivery is Firebase.                                                          |
| Today                   | `src/notifications/push/log.provider.ts`      | Logs what it would have sent, delivers nothing. The default, and what runs until credentials exist.             |
| When the keys arrive    | `src/notifications/push/firebase.provider.ts` | FCM, one client per app. Switched on by `PUSH_PROVIDER=fcm` — no code change.                                   |

### Endpoints

```
GET   /me/notifications                         any     my inbox, newest first
GET   /me/notifications/unread-count            any     the badge
POST  /me/notifications/:id/read                any     mark one read
POST  /me/notifications/read-all                any     clear the badge

GET   /admin/notification-templates             admin   every notification, with its current wording
GET   /admin/notification-templates/:code       admin   one
PATCH /admin/notification-templates/:code       admin   reword it (FR-16.3)
POST  /admin/notification-templates/:code/reset admin   put it back to what shipped
```

The inbox is one controller for patients, providers and admins: the account kind
decides which column is filtered on, so nobody can ask for anyone else's rows.
An admin reads theirs here rather than being pushed anything, because SRS 2.3
puts the panel in a desktop browser.

### Push and in-app are not two systems

The row **is** the in-app notification; a push is an attempt to put the same copy
on a lock screen. That is why the inbox works identically whether or not push
credentials exist, and why a patient who never allowed notifications still has a
complete one. It is also what makes the three delivery outcomes make sense:

| Situation                     | Status   | Why                                                                                                                                                                |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recipient is an admin         | `sent`   | No push token by design. The panel read is the delivery. Left `queued`, these pile up as a backlog nothing drains.                                                 |
| Patient or provider, no token | `sent`   | Never signed in on a handset, or signed out — which clears it (FR-1.8). They will see it in the app, so `failed` would claim it never reached them.                |
| Push rejected                 | `failed` | With the reason. The row still stands and the recipient still sees it, which is exactly why a failed push is a delivery problem to watch, not a lost notification. |

Failed rows are excluded from the inbox: they are for an operator, not a reader.

A token Firebase reports as retired is **cleared from the account row**.
Otherwise the platform pushes into the void for as long as the row lives, and a
handset that changed hands keeps receiving somebody else's alerts.

### `notify()` never throws

A safety alert that cannot be delivered must not roll back the check-in that
raised it. Every failure ends up in the row's `status` and `failure_reason`, or
in the error log, and the caller carries on.

Two things are refused **before any row is written**, and `notify()` returns
`null`:

- **A variable the caller forgot.** The result would be "Your consultation with
  &nbsp;is confirmed for ." — worse than no message.
- **A code addressed to the wrong kind of account.** `pending_documentation`
  reaching a patient would tell them their provider is behind on paperwork.

A notification nobody may read is not a notification; it is a log line, and that
is where it goes.

### FR-16.2: never naming a diagnosis, enforced twice

This is the rule the module exists to keep, and it is enforced in two places
that fail in different directions:

1. **By omission.** A template can only interpolate the variables it declares,
   drawn from one fixed list — `patientName`, `doctorName`, `serviceName`,
   `consultationTime`, `timeUntil`, `requestedItem`, `checkinDay`,
   `rejectionReason`, `count`. There is no `diagnosis`, no `riskLevel`, no
   `concern`, no `symptom`. Copy cannot name a diagnosis if nothing can carry
   one into it.
2. **By a term check**, run when an admin saves copy _and_ again on the rendered
   text. The first stops an editor typing one in by hand; the second catches a
   variable that carries one — a template can be spotless and still produce
   "Your Depression Care consultation" once a service name is substituted.

```
PATCH /admin/notification-templates/booking_confirmed
{ "body": "Your depression consultation is confirmed." }

400 CLINICAL_TERM_IN_COPY
A notification never names a diagnosis (FR-16.2), and this template copy
contains "depression". Say that something needs attention, and let the app
show what.
```

The term list is an `app_config` value, not a constant: which words count is a
clinical-governance judgement, it differs by language, and the client must be
able to add one the morning they think of it. The wording that ships is tested
against its own rule, because a guard is worth nothing if the defaults trip it.

The same instinct shapes the copy itself. `prescription_ready` says "has
finished your notes" rather than naming what was prescribed, and
`red_flag_alert` says a check-in needs attention without saying what was
answered — a lock-screen preview is read by whoever is holding the phone.

### Copy is data (FR-16.3)

All 14 templates are seeded into `app_config` on first boot and owned by the
panel from then on. A reword is live within the config cache window with no app
release, and `seed` never overwrites, so a redeploy cannot undo an admin's
wording. The change history is the `audit_log` row, which is why there is no
templates table and no version column.

An admin edits the **words only**. The audience and the variable list are
behaviour rather than copy, so they stay in the build where they can be
type-checked — and `template_code` is a `VARCHAR` rather than an enum precisely
so adding a new notification needs no migration.

### Rules the schema enforces, not the code

All four were exercised against a live database.

- `num_nonnulls(patient_id, doctor_id, admin_id) = 1` — **exactly one
  recipient.** Three nullable columns would otherwise allow a row addressed to
  nobody, which no inbox query would return, and a row addressed to a patient
  _and_ a doctor, which would show one person's alert to another. Both are
  silent without this.
- `(status = 'failed') = (failure_reason IS NOT NULL)` — a failed delivery says
  why, and one that did not fail does not. Otherwise `failed` with no reason is
  an operator staring at a dead row with nothing to act on.
- `(status = 'sent') = (sent_at IS NOT NULL)` — a sent row with no timestamp
  cannot be aged out, and an unsent row with one is a lie.
- `read_at IS NULL OR sent_at IS NOT NULL` — read before it was ever delivered
  is not a state that exists.

### Adding the FCM credentials later

Nothing in the code changes. `PUSH_PROVIDER=log` is the default and delivers
nothing while logging what it would have sent; set `PUSH_PROVIDER=fcm` with the
two service accounts and the same calls start reaching devices.

```
PUSH_PROVIDER=fcm
FCM_PATIENT_CREDENTIALS=<service-account JSON, or the same JSON base64-encoded>
FCM_DOCTOR_CREDENTIALS=<service-account JSON, or the same JSON base64-encoded>
```

Two credentials because the patient and doctor apps are **separate store
listings**, therefore separate Firebase projects, and one client cannot address
both. Both the raw JSON and a base64 encoding of it are accepted: the first is
what Google hands you, the second is what survives most secret managers with its
newlines intact — and a private key that lost its newlines fails at the first
send with an error that reads like a permissions problem.

**There is no APNs setting, and that is not an omission.** Firebase delivers to
iOS _through_ APNs using the key uploaded in the Firebase console, so the APNs
credential is configured there and never reaches this service.

`env.validation` refuses to boot production on the log provider, and refuses
`fcm` without both credentials — the same shape as the OTP and storage stubs. A
platform that silently stops notifying anybody looks perfectly healthy, which is
why it is a boot failure rather than a warning.

### Known gaps

- **Nothing raises a notification yet.** M-08 owns the machinery; the callers
  arrive with M-11 (booking confirmed), M-13 (instant requests), M-15 (pending
  documentation) and M-16 (the safety alerts). Until then the codes are defined
  and tested but unexercised in the running platform.
- **No scheduled sends.** `consult_reminder` and `checkin_due` need a job that
  decides _when_ to fire; the job belongs to the module that owns the schedule
  it reads from, not here. M-08 sends when it is asked to.
- **No retry.** A failed push is recorded and left. The recipient still has the
  in-app copy, so this is a gap in reach rather than in delivery, and a retry
  policy is worth writing once there is real failure data to shape it.
- **No per-recipient preferences.** Every notification a module raises is
  delivered; a patient cannot yet mute a category. No FR asks for it.

## M-09 Search and Concern Mapping

Turns everyday language into the right **service and concern**, with a stated
reason. Navigation, never diagnosis.

**Owns no table, and has no migration.** The symptom mapping is
`concerns.match_phrases`, owned by M-06 — a second copy here could disagree with
the taxonomy the client had approved. Recent searches live on the device
(FR-5.11). Everything else is an `app_config` value an admin edits with no
release.

| Piece            | Where                          | Notes                                                                                     |
| ---------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| The engine       | `src/search/search.service.ts` | Crisis check, ranking, then services with fee and soonest availability.                   |
| Text handling    | `src/search/query.ts`          | Normalising and synonym rewriting across scripts. Pure.                                   |
| Ranking          | `src/search/matching.ts`       | Scores the taxonomy and produces FR-5.4's reason.                                         |
| The guardrail    | `src/search/crisis.ts`         | Deterministic, runs first, never returns results alongside guidance.                      |
| Editable content | `src/search/search.config.ts`  | Crisis keywords, synonyms, popular searches, emergency guidance, disclaimer.              |
| The optional AI  | `src/search/query-assist.ts`   | A port. Default `NoQueryAssist` does nothing; OpenAI adapter behind `SEARCH_AI_PROVIDER`. |

### Endpoints

```
POST  /search                          patient  describe a problem in plain words (FR-5.1)
GET   /search/guide                    patient  the concern guide, for the unsure (FR-5.5)
GET   /search/suggestions              patient  admin-edited popular searches (FR-5.11)

GET   /admin/search/config             admin    everything M-09 reads from configuration
PATCH /admin/search/crisis-keywords    admin    clinical_governance only
PATCH /admin/search/emergency-guidance admin    clinical_governance only
PATCH /admin/search/synonyms           admin    content / clinical_governance
PATCH /admin/search/popular-searches   admin    content
PATCH /admin/search/disclaimer         admin    content / clinical_governance
```

The concern **phrases** are not here — they are columns on `concerns`, edited
through M-06's `/admin/concerns`. FR-5.9 makes the module reachable from the
home search and from an assistant entry; both are this one endpoint, so there is
no second, looser path into the engine.

### The result is a service, never a person

Since SRS 1.3 the patient picks a service and a time and never a provider, so a
result carries the fee for that **service** and the soonest the **pool** can
cover it — not a named provider with their own price and diary.

```
POST /search  { "query": "neend nahi aati" }
→ { "disclaimer": "…does not screen, diagnose or decide treatment…",
    "crisis": false,
    "results": [{ "name": "Psychiatry", "consultationFeeInr": 800,
                  "reason": "matched to: Sleep, neend nahi aati",
                  "soonestAvailableAt": "2026-09-02T07:01:15.211Z",
                  "concerns": [{ "code": "sleep", … }],
                  "matchedBy": "mapping" }] }
```

This is why **M-05 is not a dependency**. The module asks M-07
`soonestForPool({ specialtyId })` and gets a time back; resolving which
providers are in the pool happens inside the scheduler, and the roster is never
in reach here.

### Mixed-language input, without guessing

A patient types `can't sleep`, `neend nahi aati` or `नींद नहीं आती` and reaches
the same service. There is **no transliteration and no language detection** —
both guess, and a guess here routes somebody to the wrong service quietly.
Instead there are two layers the client controls, both editable with no release:
`concerns.match_phrases` for the taxonomy, and a **synonym table** for whatever
means the same as something else.

Rewriting works on **runs of words**, not one word at a time. Per-word
substitution cannot express `udaas → low mood` or `bura lagta hai → feeling low`:
one word would have to become two. Every reading is derived from the original
query and never from another reading, so `a → b → c` can never walk a query into
wording nobody wrote. The patient's own words are always kept as the first
reading, plus one reading per applicable entry, plus one with everything applied
at once — capped, so a table that grows into a thesaurus cannot turn one search
into thousands of comparisons.

The table is read in **both directions**, so an admin adding `neend: [sleep]`
never has to think about which side of the colon a word belongs on.

One thing worth knowing about the normaliser: it keeps `\p{M}`, combining marks.
A Devanagari matra is a mark, not a letter, so the obvious `[^\p{L}\p{N}]` treats
the vowel signs in नींद as punctuation and hands back न द — Hindi search silently
matching nothing while English works perfectly. A test asserts it directly.

### The crisis guardrail (FR-5.6)

If a query contains self-harm language, the platform returns emergency guidance
**instead of** results — `results` is always empty, never guidance alongside a
booking flow a patient could scroll past.

Three properties, each of which costs something:

- **It runs first**, before matching, the catalogue or the assistant. A
  guardrail that runs after the work can be skipped by the work going wrong.
- **It is deterministic** — no model, no threshold. The keyword list is
  clinically approved content (SRS 8), and a list is the only form in which
  approval means anything: a clinician can read every phrase and say yes.
- **Whole words in order.** `die` never fires on `diet`; `end it all` needs those
  three words together. A guardrail that cries wolf is one an operator turns off.

The cost is recall: it finds what the list names and nothing else. That is the
right trade for a check whose failure mode is missing somebody at their worst
moment — a guess is not better than a gap, because a guess is a gap you cannot
see. English, Hinglish and Devanagari phrases all ship, and all are tested.

> **Before launch, the client must replace the crisis list and confirm every
> helpline number.** SRS section 8 puts both among the content a qualified
> clinician approves. What ships is a starting point so the guardrail is never
> absent — an emptied list is a guardrail that never fires, and a helpline that
> has changed number is worse than no helpline at all.

### "AI-assisted", and the exact limit of it

The engine is deterministic. The optional assistant is asked **one** question —
which of these existing concerns does this wording sound like — and its answer is
filtered back down to codes already in the taxonomy, so a hallucinated category
produces nothing rather than a new one. It:

- runs **only** where the approved mapping found nothing, so a model never
  reorders clinically reviewed content;
- is **never** consulted about crisis language;
- receives the patient's words and the concern names, and nothing else — no
  name, no account id, no history;
- is labelled in the response as `matchedBy: "assistant"`, so a reader can tell
  a suggestion from an approved match.

SRS 2.4 and section 8 both say the AI module assists navigation only and must not
screen, diagnose or triage clinical severity. A model that could add its own
categories would be making a clinical judgement nobody reviewed.

`SEARCH_AI_PROVIDER=none` is the default and a complete search on its own. Unlike
the OTP, storage and push stubs it is **not** refused in production: those three
silently deliver nothing while looking healthy, whereas this only declines to add
suggestions to an answer already given in full. Set `SEARCH_AI_PROVIDER=openai`
with `OPENAI_API_KEY` to switch it on.

### Queries are not logged

FR-5.11 keeps searches off the server in this release. So nothing here writes an
audit entry, and `/search` is a **POST** rather than a GET specifically so that
what a patient typed about their mental health does not land in an access log,
a proxy log or a browser history — places this service could not have cleaned up
even if it wanted to.

Verified rather than asserted: after driving searches through the running
platform, a word from a query that appears in no configuration list ("plumber")
has zero rows in `audit_log`. What _is_ audited is the admin's config changes,
which is the change history FR-5.7 needs.

**A deliberate omission worth revisiting with the client:** a crisis hit is not
recorded either. Safety would argue for knowing that a patient searched
self-harm language; FR-5.11 and SRS 6.2 argue against keeping it. The spec is
explicit, so the spec wins here — but this is a product decision, not a technical
limit, and it is a one-line change if the client wants the opposite.

### Known gaps

- **The catalogue ships empty**, so search returns nothing until the client adds
  specialties and concerns. That is M-06's deliberate choice, inherited here:
  a guessed taxonomy at a guessed fee is worse than an empty one. The engine was
  verified against a taxonomy created through the admin API and then removed.
- **Speech input (FR-5.10) is the app's job.** Speech-to-text belongs on the
  device, and what reaches this API is text either way — the same endpoint, the
  same mapping, the same guardrail.
- **Browse by professional type (FR-5.3)** is M-06's `GET /services`, already
  shipped. Nothing was duplicated here.
- **No scoring feedback loop.** Ranking is the client's `match_weight` and phrase
  specificity; nothing learns from what patients pick, because nothing is
  logged to learn from.

## M-10 Documents and File Storage

Owns `patient_files` and `report_requests`: the patient's medical history, every
report and photo they upload, the PDFs written for them, and the requests a
provider raises for a document.

Doctor credentials are **not** here. They are `doctor_documents`, owned by M-05,
because the access rule is a different one — a credential is read by its own
doctor and a reviewing admin, a patient file by that patient and only a doctor
treating them.

| Piece          | Where                                  | Notes                                                                    |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| The files      | `src/files/patient-files.service.ts`   | Upload, read, delete — and the one access check they all go through.     |
| The requests   | `src/files/report-requests.service.ts` | FR-4.9: what a provider asked for, and what came back.                   |
| Who may read   | `src/files/consultation-access.ts`     | The port. Answers "no" to everything until M-11 binds it.                |
| Key policy     | `src/files/patient-file-storage.ts`    | The prefix and the minting that keep one patient out of another's files. |
| Shared signing | `src/storage/object-storage.ts`        | The S3/stub mechanics M-05 and M-10 both use, under different prefixes.  |

### Endpoints

```
GET    /me/files                             patient  my documents
POST   /me/files/upload-url                  patient  a signed URL to upload to
POST   /me/files                             patient  confirm, once the bytes are stored
GET    /me/files/:id/download-url            patient  a short-lived link to open one
DELETE /me/files/:id                         patient  remove one of my uploads
GET    /me/files/requests/open               patient  what my provider has asked me for

GET    /doctor/patients/:patientId/files     doctor   a patient I have consulted
GET    /doctor/files/:id/download-url        doctor   open one of their documents
POST   /doctor/report-requests               doctor   ask for a document (FR-4.9)
POST   /doctor/report-requests/:id/cancel    doctor   withdraw one still open

GET    /consultations/:id/report-requests    either   what was asked, and what came back
```

### The access rule is the module

Done when "no file opens for anyone outside that patient's own care", so every
read — list, download, delete — goes through **one** gate rather than each
endpoint remembering to check. It has exactly three ways through:

1. the patient, for their own files;
2. a doctor who **has consulted that patient**, via `ConsultationAccess.isTreating`;
3. nobody else.

An **admin is not on that list.** SRS 6.2 gives an admin the panel, not the
clinical record, and `assertOwnership`'s `adminMayAccess` is deliberately unused
in this module. A support question about a file is answered from the audit
trail, which records every read without exposing one.

A file that is not yours returns **404, never 403**. A distinct "forbidden"
would confirm that a file exists for a patient the caller may not read about,
which is itself the disclosure being guarded.

### Closed until M-11, on purpose

`CONSULTATION_ACCESS` is a port with a default that answers **no** to every
question, because `consultations` is M-11's and does not exist yet.

That direction is the whole point. A stub that guessed "yes" would open every
patient's medical history to every signed-in doctor, silently, in a build that
passed its tests. The conservative answer costs a feature that has no data to
work on; the optimistic one costs a privacy breach. So in this build a patient
can upload and read their own record in full — the part of M-10 with no booking
dependency — and every doctor-facing read refuses. Verified live: a verified,
listed doctor gets `404 FILE_NOT_FOUND` on a patient's files and their download,
and `404 CONSULTATION_NOT_FOUND` on raising a request.

`@VerifiedDoctorsOnly()` is the outer door and `isTreating` is the inner one.
Verification says somebody may practise on this platform; it says nothing about
whether they may read **this** patient, and only the second question protects
the record.

### Uploading is two calls, and the bytes never touch this API

Ask for a signed URL, PUT the file straight to the object store, then confirm.
A large upload cannot occupy an API worker, and a stored file has no public
address at all (SRS 6.1).

The **client never chooses where its file lands**. The key is minted from the
patient's own id and a fresh uuid, and confirm only accepts a key issued to that
patient — so one patient cannot write over another's report by naming their key,
and a hostile file name cannot walk out of the prefix. The file **name** is kept
off the key too: it is clinical detail, and a key ends up in bucket listings and
access logs.

```
patient-files/<patientId>/report/<uuid>.pdf     # never "hiv-results-final.pdf"
```

A row and an object can only disagree in one direction: if the client never
confirms, an object is orphaned and M-21's retention sweep takes it. The
reverse — a row pointing at nothing — cannot happen, because the row is written
last.

### Medical history belongs to the patient, not a booking

`medical_history` is uploaded before any consultation exists and is still
readable at every later one, so it carries no `consultationId` — a CHECK
enforces it, and the service strips one if a client sends it. That is what lets
a treating doctor read the history that **predates their own first session**,
which is the whole reason the category is held against the patient.

### A request is fulfilled by the file arriving

FR-4.9: the provider names what is needed and why, the reason is shown to the
patient, and the patient uploads **against the request** — so the file arrives
labelled instead of as an unexplained attachment.

`report_requests` carries **no patient and no doctor**: both are read through the
consultation, where the treating doctor is always `consultations.doctor_id`, so
there is no second copy of who is involved that could disagree with the booking.
It carries **no `fulfilled_at`** either — the arriving `patient_files` row's own
`created_at` is that time, and one timestamp cannot disagree with itself. The
file and the status change are written in one transaction.

A request can be cancelled only while **open**. One the patient has already
answered is a record of what was asked and what arrived, and cancelling it
afterwards would rewrite that.

### Deleting, and what a patient may not delete

A patient removes their own upload — unless a **completed** consultation relied
on it, and never anything their provider uploaded, which is the clinician's
entry about them rather than their file. A consultation this module cannot
resolve is treated as "keep": a file attached to a booking it cannot read about
is not one to delete on a guess.

It is a **soft delete**. `deleted_at` is set and every read stops returning it;
the stored object is left for M-21's retention job. Erasing bytes here would put
the DPDP deletion path in two places, when M-03 already owns the request and
M-21 owns the execution and its evidence.

### Rules the schema enforces, not the code

All five were exercised against a live database.

- **De-identification is structural.** `CHECK (clarification_case_id IS NULL OR
patient_id IS NULL)` — a file attached to an expert-opinion case is stored as
  a scrubbed copy with no patient, so an expert-facing query cannot reach a
  patient through it even by mistake. FR-12.2 strips identifiers before a case
  is shared; this makes that true of every query anyone writes later, not only
  the careful ones.
- `patient_id IS NOT NULL OR clarification_case_id IS NOT NULL` — every file
  belongs to somebody. A row with neither is a stored object nothing can reach,
  and no access check would refuse it because no owner would match.
- `report_request_id IS NULL OR consultation_id IS NOT NULL` — a file answering
  a request must belong to the booking it was raised in, or the doctor who asked
  would never see it.
- `file_category <> 'medical_history' OR consultation_id IS NULL` — history is
  not per-booking.
- `storage_key` is **unique**, so two rows can never point at one object.

The uploader key is `ON DELETE NO ACTION`, not Prisma's default `SET NULL`: a
null there _means_ "the patient uploaded it themselves", so nulling it would
rewrite who wrote a clinical record — and would let the patient delete it.

### Known gaps

- **Every doctor-facing read refuses**, because `ConsultationAccess` is closed
  until M-11. The rules above it are complete and tested against an injected
  implementation; nothing in this module changes when M-11 binds the real one.
- **`storeGeneratedPdf` has no caller.** M-17 renders the prescription and
  therapy-plan PDFs and calls it; the capability exists first because a
  generated PDF is never uploaded and needs no endpoint.
- **De-identified clarification copies are M-12's to create.** The column, the
  CHECK and the exclusion from every patient-facing read are here; the scrubbing
  and the case belong to that module.
- **The stub object store holds no bytes.** Local runs exercise keys, rows and
  every access rule in full; only the file itself is missing, and
  `env.validation` refuses the stub in production.

## M-11 Booking

Owns `consultations` — **the spine**. `consultations.id` is the consultation ID
every clinical and financial record hangs from, and this is the module that
issues it.

| Piece                 | Where                                 | Notes                                                                       |
| --------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Assignment (SRS 4.20) | `src/booking/assignment.service.ts`   | The four inputs, the tie-break, the refusal. Writes _why_ to the audit log. |
| The booking           | `src/booking/booking.service.ts`      | Book, hold, decline, cancel, reschedule, override, no-show.                 |
| Releasing the hold    | `src/booking/hold-sweeper.service.ts` | A sweep every minute. This is what makes the hold safe to take.             |
| The four ports        | `src/booking/booking.adapters.ts`     | Closes what M-04, M-05, M-07 and M-10 declared.                             |
| The reference code    | `src/booking/reference-code.ts`       | `CC-JBMF-KP3R` — what a patient reads down a phone line.                    |

### Endpoints

```
GET   /me/consultations                            patient  upcoming or past (FR-6.5)
POST  /me/consultations                            patient  book a service and a time (FR-6.1)
POST  /me/consultations/instant                    patient  Consult Now
GET   /me/consultations/:id                        patient  one of mine
POST  /me/consultations/:id/decline-provider       patient  ask for another (FR-4.4)
POST  /me/consultations/:id/cancel                 patient  cancel (FR-6.4)
POST  /me/consultations/:id/reschedule             patient  move it (FR-6.4)

GET   /doctor/consultations                        doctor   my list
GET   /doctor/consultations/:id                    doctor   one of mine
POST  /doctor/consultations/:id/no-show            doctor   the patient did not attend
POST  /doctor/consultations/:id/cancel             doctor   one I cannot take

GET   /admin/consultations/:id                     admin    one consultation
POST  /admin/consultations/:id/override-provider   admin    reassign to a named provider (FR-20.8)
POST  /admin/consultations/:id/cancel              admin    on a patient's behalf
```

**No patient endpoint takes a provider.** FR-20.1 says a patient cannot choose,
request or be shown a choice of provider, and the shape of the controller is
where that is kept: a `specialtyId` and a time go in, and who they will see
comes back. The only path in the whole module that names a provider is the admin
override.

### Assignment (SRS 4.20)

Four inputs, and nothing else:

| Input            | Rule                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Specialty**    | The service the patient chose.                                                                                                                 |
| **Language**     | **Hard (FR-20.4).** No policy setting relaxes it, and no branch skips it — every pool query carries it, including the relaxed-region one.      |
| **Region**       | A **preference** (FR-20.5). The in-region pool is tried alone first; only an _empty_ result moves outside it, and the row records that it did. |
| **Availability** | Free **for long enough** at that moment (FR-10.7), asked of M-07 — each provider judged against their own duration + buffer.                   |

Ties are broken by the admin's policy (FR-20.6): `fewest_upcoming` (the
load-balancing default), `longest_free`, or `least_recently_assigned` — under
which a never-assigned provider sorts first, so a new provider gets work rather
than waiting for everyone else to fall behind them.

Where nobody qualifies the answer is a **refusal with the next time the pool can
cover it** (FR-20.7), never a fallback to somebody who does not match. That
"next time" carries the language too: a slot only an English-speaking provider is
free at does not cover a patient who needs Hindi, and offering it would send them
back to the same refusal.

### Why this provider — the log, not a column

MODULES is explicit: _"the consultation records WHO, the log records WHY, and why
is a record of a decision rather than an attribute of the appointment."_ So there
is no `matched_on` column. A live assignment writes:

```json
{
  "assignedDoctorId": "…",
  "language": "hi",
  "regionId": "…",
  "regionRelaxed": false,
  "tieBreak": "fewest_upcoming",
  "poolSize": 1,
  "availableCount": 1,
  "availableMinutes": 480,
  "declinedCount": 0
}
```

**A refusal is recorded too.** No consultation is created when a pool comes up
empty, so without this the client would never learn that demand arrived and could
not be met — and that is a staffing signal, not a non-event.

### Booking and consultation are one row

There is no holds table. A row with status `pending_payment` **is** the slot
hold, and the same row becomes the consultation when payment settles — a hold and
the booking it becomes are the same appointment at two moments, so two rows would
only be a way for them to disagree.

- **Paid service** → `pending_payment` with a `holdExpiresAt` (`booking.hold_minutes`, admin-editable, default 10).
- **Free service** → booked outright as `scheduled`. M-06 allows a zero fee deliberately, and a hold on one could never be settled, so every such booking would expire.
- **Payment settles** → `confirmPayment()` moves it on and **clears** the expiry, so the sweeper can never take a paid consultation. Idempotent, because a gateway delivers the same webhook twice.

An abandoned checkout becomes **`expired`, not `cancelled`**. Nobody decided it —
and a CHECK refuses a cancelled row with no author, which is exactly why the two
are different statuses.

### Two patients cannot take the same slot

Two locks, and both are needed:

1. **M-07's `assertFree`** runs before the write and gives the clear message —
   this catches the far commoner case of a slot that was never offered.
2. **A partial unique index** on `(doctor_id, scheduled_start_at)` is the last
   word. A check and a write are two statements, and two requests can both pass
   the check before either writes; only the database settles that. A `P2002`
   comes back as `SLOT_TAKEN`.

It is **partial** over the four statuses that actually hold time. Verified live:
a second live booking at the same instant is rejected, while a **cancelled** one
at that instant is accepted — which is the whole point of releasing an abandoned
checkout.

### The four ports this module closes

Four earlier modules each needed one question answered about `consultations` and
could not answer it. Each declared a port and bound a **closed** default, so a
missing dependency could never read as permission. M-11 replaces them:

| Port                  | Declared by | The question                                |
| --------------------- | ----------- | ------------------------------------------- |
| `PATIENT_ASSIGNMENT`  | M-04        | Is this doctor treating this patient?       |
| `DOCTOR_METRICS`      | M-05        | The reliability figures, counted not stored |
| `BOOKED_INTERVALS`    | M-07        | What time is already taken                  |
| `CONSULTATION_ACCESS` | M-10        | Who may open a patient's files              |

Not a line changed inside any of them. One class answers two of the four,
because M-04 and M-10 are asking the same question in different words.

Two things about the wiring are worth knowing, because both were caught by the
app refusing to boot rather than by a test:

- **A module's own provider beats a global one.** Each of the four had to _stop_
  providing its closed default — leaving it in place would have kept every one of
  them shut, silently. This is the same handover M-06 made when it bound M-05's
  `SPECIALTY_CATALOGUE`.
- **A `@Global()` module shares only what it EXPORTS.** A port bound here but
  missing from `exports` leaves the module that declared it unable to resolve its
  own dependency.

A booking's occupied interval is duration **plus buffer**: a 30-minute
consultation with a 5-minute buffer takes 35 minutes off the diary, because the
buffer is time the provider is not available to anyone else.

### Declining a provider (FR-4.4)

The reason is **required**, and the count comes from the audit log rather than a
column — each decline and its reason have to be recorded anyway, "so a provider
declined repeatedly is visible to the client rather than invisible", and a
counter beside those entries would be a second copy of their number.

Past the configured limit (`maxPatientDeclines`, M-06's policy) the booking
stands: continue with the provider assigned, or cancel. A decline is recorded
**even when no replacement is found** — the decline happened either way.

### Rescheduling makes a new row

Not a moved `scheduled_start_at`. The old time is part of the record — a patient
was told it, a provider held it — so the original is cancelled with reason
`Rescheduled` and a new consultation links back through
`rescheduled_from_consultation_id`. **The assignment is made again from scratch**,
because whoever was free on Tuesday may not be free on Thursday, and FR-20.2 is
about the time actually being booked. A patient who had already paid is not
charged twice: the new row starts where the old one had got to.

### Rules the schema enforces, not the code

All exercised against a live database.

- `consultations_no_double_booking` — the partial unique index above.
- `hold_expires_at IS NULL OR status = 'pending_payment'` — **the hold is the
  pending row.** A paid booking still carrying one would be swept away by the
  very job that releases abandoned checkouts.
- `(status = 'cancelled') = (cancelled_at IS NOT NULL)` and cancelled implies a
  party — a cancellation records who made it.
- `mode <> 'scheduled' OR scheduled_start_at IS NOT NULL` — a scheduled booking
  is a time; an instant one happens now.
- `duration_minutes > 0`, `feedback_rating BETWEEN 1 AND 5`, and a consultation
  cannot be its own reschedule.

This migration also closes every foreign key the earlier modules left open:
M-05's completion gate (`SET NULL`, so the gate _opens_ rather than stranding a
provider), M-10's files (`NO ACTION`) and report requests (`CASCADE`), plus
`patient_files_one_prescription_pdf`, which needed `consultations` to exist.

### A bug this module found in M-07

Integration surfaced one that unit tests could not: **Prisma cannot write a
`time` of `24:00`.** It serialises a JS Date's time-of-day only, so 1440 minutes
arrived as `00:00:00` and tripped M-07's `start_time < end_time` CHECK — every
weekly pattern ending at midnight failed to save.

Postgres accepts `24:00:00`, and the diary needs it: a window ending at midnight
must **meet** the next day's `00:00` window exactly, or the two stop merging and
a night shift reads as two short runs with a gap — which is precisely what
FR-10.7's "unbroken availability" must not do. M-07's availability writes now
pass the times as SQL literals; reads were already correct, because
`minutesFromTimeColumn` counts the day rollover.

### Known gaps

- **Nothing pays yet.** `confirmPayment()` is the call M-12's webhook will make;
  until then a paid booking stays `pending_payment` and expires. A **free**
  service books end to end today, which is how the flow was verified.
- **Instant consults are created, not routed.** M-11 writes the `awaiting_doctor`
  row with no provider; the acceptance window, timeout and re-routing are M-13's,
  and they call this module's assignment rather than a routing rule of their own.
- **`acceptanceRate` and `caseSummaryCompletion` stay null.** They need
  `instant_consultancy` (M-13) and `clinical_records.finalised_at` (M-15). Null
  rather than zero, for the reason M-05 gave: a provider offered nothing has not
  failed to accept anything.
- **`completed` still has no writer.** M-14 now drives `in_progress` and
  `awaiting_documentation` through `markInProgress()` and `markCallEnded()`,
  which this module owns and LiveKit's webhooks call. Closing the case is
  M-15's, and it is gated on the clinical record being finished.
- **Cancellation is not yet policy-driven.** FR-6.4's "within the configured
  policy" and the refund it implies are M-12's; today cancelling is allowed until
  the consultation starts.

## M-14 Video Consultation

Puts the patient and the doctor into the same secure call, and records what
happened there. Owns `consultation_participants`.

**LiveKit is not in this service and never will be.** It is a separate server
process — a container locally, an EC2 instance in production — and the audio and
video go client ↔ LiveKit ↔ client. This module is the control plane: it decides
who may enter a room, signs a token that says so, and writes down what LiveKit
reports afterwards. Nest is never in the media path.

```
Client                          Client
   |  1. POST .../video/token      ^
   v                               |
Nest  ── authorises, mints ────────┘
   |                          3. WebRTC media
   |  2. token                     |
   v                               v
LiveKit Server  ────────────────────
   |
   |  4. signed webhooks
   v
Nest → consultation_participants
```

### Endpoints

| Method | Path                                     | Who                                      |
| ------ | ---------------------------------------- | ---------------------------------------- |
| GET    | `/consultations/:id/video/readiness`     | the two parties                          |
| POST   | `/consultations/:id/video/token`         | the two parties                          |
| GET    | `/consultations/:id/video/session`       | the two parties                          |
| GET    | `/admin/consultations/:id/video/session` | operations, clinical governance, finance |
| POST   | `/video/webhook`                         | LiveKit, by signature                    |

`readiness` answers "will Join work, and where do I connect" without minting
anything, so the app can run FR-8.2's camera, microphone and network checks
without starting a five-minute clock it might outlive.

### Only the two assigned participants, enforced four times

M-14 is done when only the assigned patient and doctor can join. A video room is
the one place on this platform where a mistake cannot be undone — a third party
in a clinical call cannot be un-heard — so the rule is enforced independently at
four layers, and no single bug removes it:

1. `VideoService` mints a token for the two parties and refuses everyone else,
   **admins included**. That is the one place in this codebase where an admin is
   not let through `requireParty`; they can reassign the provider, refund the
   payment and read the session record without being in the room.
2. The grant is scoped to one room, with no `roomList` (which would enumerate
   every consultation on the platform) and no `roomAdmin` (which would let a
   participant remove the other one). No `roomRecord`, no data channel, no
   self-metadata.
3. `max_participants: 2` in `livekit.yaml`, enforced by the media server itself.
4. A CHECK on `consultation_participants.party` refuses to record anyone but a
   patient or a doctor having been there.

A join also requires consent (M-03), a `paid` payment row (M-12), a joinable
status, and — for a scheduled consultation — that it is within
`video.join_window_minutes` of the start. There is no closing bound to match the
opening one: consultations overrun, and a call cut off mid-sentence by a clock
would be the worse failure.

### Three things that are not stored, and why

- **The room.** Its name is `consultation-<id>` — a pure function of the
  consultation, derived in both directions, so the webhook finds its
  consultation from the room name alone. A stored name could disagree with its
  row, and would let two rooms exist for one consultation.
- **The token.** It lives for minutes and cannot be revoked, only expired.
  Writing it down would make a second copy of the very thing the short TTL
  exists to limit. Its **issue** is an `audit_log` entry, which is what answers
  "who was let into this call" later.
- **Every figure about the call.** Session start is `min(joined_at)`, end is
  `max(left_at)`, duration is the time both parties were connected at once, and
  the no-show is the party with no row. None is a column.

Duration is the **overlap**, not the sum and not the span: summing both sides
would count a two-way call twice, and `end - start` would credit a doctor who
sat alone for twenty minutes with a twenty-minute consultation.

### One row per connection, not per person

`participant_joined` and `participant_left` fire per **connection**, and a phone
that loses signal mid-consult produces several of each. The four timestamps this
replaced (`patient_joined_at` … `doctor_left_at`) could hold the first join and
the last leave and nothing between, so a reconnect silently overwrote the
session it was resuming.

The primary key is LiveKit's `PA_xxx` participant SID, generated per connection
and never reused. **That choice is the idempotency**: a redelivered webhook
collides and changes nothing, where an upsert would rewrite a join time already
recorded. Leaves close only a row that is still open, and `room_finished` closes
anything a lost leave webhook left dangling — without which one missing webhook
leaves a connection that appears to run for ever.

### Rules the schema enforces, not the code

- `party IN ('patient', 'doctor')` — the shared enum has four values and only
  two can ever have been in a call.
- `left_at IS NULL OR left_at >= joined_at` — both times come from LiveKit
  rather than from us, and the alternative is a negative duration.
- `disconnect_reason IS NULL OR left_at IS NOT NULL` — LiveKit sends the reason
  **on** the leave event, so one cannot arrive without the other.

`disconnect_reason` is a varchar, not an enum: LiveKit owns that vocabulary and
adds to it between versions, and a value this build has not heard of must land
in the row rather than fail the webhook. It is the only thing separating a
hang-up from a dropped network when a technical-issue complaint or a refund is
adjudicated, which is why an admin can read the session record.

### Nothing is recorded

FR-8.6. No egress is configured, the token carries `roomRecord: false`, and
there is no bucket, no retention period and no deletion question to answer. The
token also carries no participant name and no metadata, because both are handed
to the other participant and appear in LiveKit's logs — the doctor's screen gets
the patient's details from this API under its own authorisation (FR-8.4), so no
identifying detail has any reason to enter the media plane.

### Verified against a live LiveKit

Run end to end against LiveKit 1.9.12 in the compose file, with two real WebRTC
clients. `LiveKit_strategy` 30's tests 1 to 5 and 9 pass: the server starts,
tokens are issued and refused correctly, both parties join the same room,
LiveKit rejects a tampered token, and the webhooks land as rows.

**It found a bug no unit test could.** LiveKit sends
`Content-Type: application/webhook+json`, not `application/json`. Fastify has no
parser for it, so every delivery was refused with a **415 before reaching any
handler** — signature never checked, event never seen,
`consultation_participants` never written. Nothing looked wrong from the inside:
tokens issued, calls connected, and not one session recorded. Fixed in
[`src/common/webhook-body.ts`](src/common/webhook-body.ts) and locked in by
[`test/video-webhook.e2e-spec.ts`](test/video-webhook.e2e-spec.ts), which is an
e2e test precisely because the failure lived above every seam a unit test mocks.

It also surfaced `participant_connection_aborted` — a party who reached the room
but whose media never came up, which is what a restrictive network with no TURN
produces. LiveKit fires it **instead of** `participant_joined`, so there is no
session and deliberately no row: `joined_at` means "connected", and a row would
make someone who never got in look like they attended. It is audited instead,
because "I could not get into the call" has to be answerable.

A real reconnect produced exactly the three rows the table exists for:

```
PA_bZySDsLLhS5t  doctor   10:29:14 -> 10:29:25   CLIENT_INITIATED
PA_eXwCUGtb2g6b  patient  10:29:15 -> 10:29:18   CLIENT_INITIATED   <- signal lost
PA_7p3c5wVr4897  patient  10:29:22 -> 10:29:25   CLIENT_INITIATED   <- came back
```

Session span 11s, doctor connected 11s, patient 6s across two connections, and
**duration 6s** — the overlap, with the 4-second gap correctly excluded. The four
timestamps this replaced would have reported the patient present for the whole
10 seconds and hidden the drop entirely.

### Known gaps

- **AWS is not deployed.** Strategy phases 8 to 13 — EC2, Elastic IP, security
  group, DNS, Caddy/TLS, `use_external_ip`, TURN and observability — are
  infrastructure work. `docs/DEPLOYMENT.md` records what they require; only
  `LIVEKIT_URL` and the key pair change in this codebase.
- **TURN is not configured, and tests 7 and 10 are not run.** Restrictive-network
  fallback must be exercised from a genuinely restricted connection rather than
  from this LAN, and load testing needs the AWS node. Both need infrastructure
  this machine does not have.
- **`completed` is now M-15's**, and it arrives with the clinical record — see
  below. M-14 leaves a finished call in `awaiting_documentation` and goes no
  further.

## M-15 Clinical Records

Holds the clinical record of each consultation and enforces that it is finished
before the case closes. Owns `clinical_records`, one row per consultation.

**The record freezes.** `finalised_at` is the moment it stops being a draft and
becomes evidence: a prescription the patient is holding, and the handover the
next clinician reads. Nothing edits it afterwards, and there is no method on the
service that does — that absence is the requirement. A correction is a new
consultation, never a quiet edit of what was already issued.

It is a table of its own rather than columns on `consultations` for that reason:
the record freezes while the consultation row goes on changing through a week of
follow-up, and two lifetimes cannot share one row.

### Endpoints

| Method | Path                                                 | Who                             |
| ------ | ---------------------------------------------------- | ------------------------------- |
| GET    | `/doctor/pending-documentation`                      | treating doctor                 |
| PUT    | `/doctor/consultations/:id/clinical-record`          | treating doctor                 |
| GET    | `/doctor/consultations/:id/clinical-record`          | treating doctor                 |
| POST   | `/doctor/consultations/:id/clinical-record/finalise` | treating doctor                 |
| GET    | `/me/consultations/:id/care-record`                  | that patient                    |
| GET    | `/admin/consultations/:id/clinical-record`           | clinical governance, operations |

The save is a `PUT` and a full replace, because the doctor's form autosaves the
whole record; sending half of it clears the other half, which is what "replace"
means and what the form does anyway.

### FR-11.5 is a database rule, not a convention

> "A consultation is marked clinically complete only after the prescription or
> advice is finalised and the case summary is submitted. This rule is enforced by
> the system, not by convention."

A service check **is** a convention: it holds until somebody adds a second write
path. So the rule is held in two places that cannot drift apart:

- `clinical_records_finalised_is_complete`, a CHECK that refuses any finalised
  row without a case summary and without either a medicine line or the advice;
- `completion.ts`, which decides **which** of the two this professional owes —
  a question no constraint can answer, because it needs the specialty — and
  reports what is missing as a list a doctor can act on.

That list is the same one FR-9.3's worklist renders, so the worklist and the
finalise call agree by construction rather than by being kept in step.

**Which closing record is owed depends on the profession, and the difference is
deliberate:**

- A **prescribing** professional may close with a prescription _or_ with advice.
  Not every consultation ends in medicine, and refusing to close one that ends in
  "no medication indicated, here is the plan" would push doctors into prescribing
  something to get the case shut.
- A **non-prescribing** professional must close with the advice and therapy plan.
  It is the only closing record they can write, so there is no branch that lets
  an empty one through — and they could not have saved a medicine anyway.

Case summaries take three to five lines. The floor is the point: a one-line
summary is not a handover. The ceiling keeps it a summary rather than the notes
written twice.

### The completion gate now has both halves

FR-10.5's gate had no caller at all before this module: `blockUntilDocumented`
existed and nothing invoked it, so the rule was written down and never enforced.
It is now a loop across three modules, joined by an event so none of them reaches
into another:

```
M-14  LiveKit room_finished
        |
M-11  markCallEnded  ──publish──▶  consultation.documentation_due
                                      |
M-13  PresenceService  ──────────────▶ gate SHUT (instant consults only)
                                      |
M-15  finalise  ─────────────────────▶ gate OPEN, consultation completed
```

M-11 owns the status and must not know what a presence gate is, which is why it
announces rather than calls. The gate shuts for **instant** consultations only,
which is what FR-10.5 says — a scheduled consultation is written up between
appointments, and blocking on it would take a provider off instant duty for the
rest of the day.

Finalising does three things that must not come apart: the record freezes, the
consultation completes, and the gate opens. The first two share a transaction.
Opening the gate does not, because it is another module's row and a failure there
must never roll back a finalised clinical record — the case _is_ documented
either way, and a stuck gate is a support call rather than a lost record.

### Two views of one record

The patient's view is deliberately narrower than the professional's and matches
what the prescription PDF will print: the diagnosis, what to take, what to do and
when to worry. It omits the clinical history, the case summary and the risk
category — the case summary is a handover written for the next clinician, and a
risk category is a triage decision that means something quite different read by
the person it is about.

A draft is not shown to the patient at all. Half a prescription is worse than
none.

An admin with clinical-governance or operations rights **reads** a record and can
never write one: the professional who saw the patient is the one accountable for
what it says.

### Rules the schema enforces, not the code

- Finalised implies a case summary plus a medicine or advice (above).
- `medicines` and `recommended_content_ids` are jsonb **arrays** — the completion
  CHECK counts `jsonb_array_length`, and an object there would break it.
- `chief_complaint` is non-blank. It is the one note with no useful empty state.
- `referral_note` is either absent or says something. A blank one would assert
  that a referral was advised while saying nothing about what for, which is the
  exact state the missing `referral_advised` flag existed to prevent.

### Verified live

Run end to end against the API and Postgres. Both database refusals and both
service refusals fire; all three of MODULES' completion criteria hold:

- finalising is refused with a checklist while a summary or a closing record is
  missing, at the API **and** by the CHECK when SQL goes round it;
- a psychologist gets `403 PRESCRIBING_NOT_PERMITTED` on a medicine and no row is
  written, then closes the same case on the advice plan alone;
- the finalised record is refused every edit, drops off the worklist, and the
  case rebuilds from the consultation id across booking, payment, prescription,
  summary and audit trail.

The gate loop was driven with a real signed `room_finished` webhook: the doctor
went to `completing_notes` with the consultation id recorded against them, and
finalising cleared it.

### Known gaps

- **No prescription PDF yet (FR-9.5).** The record and both views are complete,
  but nothing renders them to a file. It needs a PDF library and a server-side
  `put` on `ObjectStorage`, which today only signs URLs for a client to upload
  through. `PatientFilesService.storeGeneratedPdf` and the
  `patient_files_one_prescription_pdf` unique index are already waiting for it.
  The wording and branding of that document are the client's to author (SRS 8),
  as the legal copy is.
- **`recommendedContentIds` is stored unvalidated.** It points at M-18's
  `content_items`, which does not exist yet, so nothing yet checks that an id is
  real or that the article is published.
- **A clinical doubt has nowhere to go.** It is an M-17 `clarification_cases`
  row, and M-17 is not built. There is deliberately no flag on this record to
  stand in for it — a flag beside the case could disagree with it.
- **Report requests are M-10's and already work.** MODULES has M-15 raise the
  request for the next session; `POST /doctor/report-requests` already does
  exactly that, so this module does not duplicate it.

## M-16 Follow-Up and Patient Safety

Keeps care running for seven days after the consult and raises safety alerts in
time. Owns `followup_pathways`, `checkin_responses` and `safety_alerts`.

This is the platform's differentiator, so the rules are **data, not code**:
FR-13.7 requires an admin to change question wording and red-flag thresholds
with no app release behind them, because a rule that turns out to fire too often
has to be fixable this afternoon for patients who are already mid-follow-up.

### Endpoints

| Method   | Path                                        | Who                                   |
| -------- | ------------------------------------------- | ------------------------------------- |
| GET      | `/me/consultations/:id/care-plan`           | that patient                          |
| GET      | `/me/consultations/:id/checkin`             | that patient                          |
| POST     | `/me/consultations/:id/checkin`             | that patient                          |
| GET      | `/me/consultations/:id/checkins`            | that patient                          |
| GET      | `/doctor/followup-pathways`                 | treating doctor                       |
| POST     | `/doctor/consultations/:id/followup`        | treating doctor                       |
| POST     | `/doctor/consultations/:id/followup/cancel` | treating doctor                       |
| GET      | `/doctor/consultations/:id/checkins`        | treating doctor                       |
| GET/POST | `/doctor/safety-alerts…`                    | treating doctor                       |
| GET/POST | `/admin/followup-pathways…`                 | clinical governance, content          |
| GET/POST | `/admin/safety-alerts…`                     | care coordinator, clinical governance |

### Red is never diluted

There is no scoring, no arithmetic over severities and no threshold. One
clinician-approved red-flag rule firing is a red day however green everything
else was — a patient reporting thoughts of self-harm alongside a better mood is
not an amber, and any design where good news could offset that is the wrong
design.

Grading is a pure function in [`pathway.ts`](src/followup/pathway.ts), given the
pathway rather than reading one, so the rules that decided a status can be
replayed exactly from the pinned version and the stored answers. That is why
`checkin_responses` stores no `triggered_rules`: the function **is** the record
of how a status was reached.

Options carry `green` or `amber` and deliberately cannot carry `red`. A red
status comes only from a rule, because every rule carries the plain-words reason
its alert is raised with — an option that could silently force red would produce
an alert nobody could explain.

### The pathway version is pinned, and editing never mutates

`consultations.followup_pathway_id` points at one **version**, not at a code.
Publishing a revision writes a new row and flips `is_current`; the old version
stays exactly as it was for everyone part-way through it.

Without that, an admin editing a question on day three would make yesterday's
answer and today's incomparable — and comparing day two with day six is the
entire value of a daily check-in. It would also leave an alert raised last week
pointing at a rule that no longer says what it said.

A partial unique index refuses two current versions of one pathway, so "which
set does a new assignment get" always has exactly one answer.

### FR-13.8, enforced by construction

> "Doctor-added questions collect answers only. They carry no red-flag rules, so
> safety alerting stays on the clinician-approved set."

If a doctor's own question could grade a day, a red flag would mean something
different depending on who was treating the patient. So the doctor's questions
are **filtered out before the evaluator ever sees them** — there is no path by
which one could be graded, and the evaluator has no idea they exist.

The nastiest case is a doctor whose question id collides with an approved one.
Filtering by id drops the _approved_ question from grading rather than grading
the doctor's, which is the safe direction. Both the unit test and a live run
confirm it: a doctor-added question with an amber-flagged option, answered with
that option, left the day green.

### Absence is the signal

A missed check-in is a **missing row**. Nothing writes "not answered", so nothing
has to remember to, and there is no state where a patient answered and the
platform believes they did not. The cost is that nobody notices unless something
goes looking, which is what
[`checkin-sweeper.service.ts`](src/followup/checkin-sweeper.service.ts) is.

It runs hourly rather than daily: a daily job has one chance to run, and a
process down at that minute loses a seventh of a seven-day window. Two
consecutive missed days raise an alert, not one — one missed day is a busy
afternoon, and alerting on it is how a governance queue stops being read. The
threshold and the prompt hour are both `app_config` values.

### The alert is the record; the notification is the postman

The `safety_alerts` row is written first and always. Delivery is attempted
afterwards and its failure is logged, never thrown: a push that does not arrive
is bad, but an unrecorded safety finding because a push failed is unforgivable,
and the governance queue is what a care coordinator actually works from.

Open, acknowledged and closed are the two timestamps — there is no status column
beside them that could disagree. A CHECK refuses an alert closed without having
been acknowledged, because nobody closes a safety alert they did not look at,
and another refuses an acknowledgement with no acknowledger.

Notification copy carries the patient's name and nothing else: no answer, no
category, no diagnosis. A lock-screen preview is read by whoever is holding the
phone (FR-16.2). **A patient never sees the alert their own check-in raised** —
they get emergency guidance instead (SRS 6.3), because telling somebody in
crisis that they have been flagged is not care.

### The Care Plan stores nothing

FR-14.1's one screen is a read across four modules — prescription and warning
signs from M-15, today's check-in and the plan from here, the booking from M-11,
recommended reading from M-18 when it exists. A Care Plan table would be a fifth
copy of four things, stale the moment a doctor changed one of them.

### Rules the schema enforces, not the code

- One current version per pathway code (partial unique index).
- One check-in per patient per day — a second submission must not overwrite an
  answer a clinician may already have acted on.
- `questions` and `red_flag_rules` are jsonb **arrays**; a published pathway must
  have at least one question, or every patient on it silently stops checking in.
- Exactly one acknowledger, and none without a time.
- An alert cannot be closed before it was acknowledged.

The service adds the one rule SQL cannot see: every red-flag rule must name a
question that exists in the set. A rule pointing at a missing question can never
fire, which is the worst failure available here — a safety rule that looks
present in the admin panel and is silently dead for every patient on the pathway.

### Verified live

Run end to end against the API and Postgres. Five pathways seeded on first boot;
a plan assigned with a doctor-added question; a green day, a duplicate refused, a
missing required answer refused, and a red day producing four distinct findings
with `showEmergencyGuidance` true. One alert per finding — not one per rule —
with the side effect under its own type. The alert was refused a close, then
acknowledged and closed with a note. The Care Plan assembled prescription,
warning signs, day 2 of 7 and today's eight questions in one call.

**It found a safety bug.** `notifyAdmins` filtered admins by **exact** permission
level, while `assertPermission` has always treated `super_admin` as passing
everything. On a fresh deployment — where super admin is the only level that
exists yet, including the client's on day one — a red-flag alert reached the
treating doctor and **no admin at all**, silently. Fixed in M-08, where the
inconsistency lived: super admins are now included in every level. The first fix
then sent each super admin the same alert twice (once per addressed level), so
`notifyAdmins` now takes several levels in one call and de-duplicates.

### Known gaps

- **Follow-up booking (FR-13.6) is not wired.** Amber and red statuses should
  offer "book with the same doctor, or the earliest available if urgent". M-11
  owns booking and assigns the provider by pool rules; continuing with the _same_
  doctor is a variation it does not expose yet. The alert and the prompt exist;
  the one-tap rebooking does not.
- **`followup_due` alerts are never raised.** The type exists and is handled, but
  nothing decides when a follow-up falls due — that is the same FR-13.6 work.
- **Care Hub reading is ids only.** M-18 owns the articles; resolving them here
  would mean copying content this module has no business holding.
- **The shipped question wording is placeholder clinical content.** FR-13.1's
  five pathways and FR-13.5's seven red flags are covered and tested for
  coverage, but the wording and thresholds need the client's clinician to sign
  them off under SRS 8 — exactly as the legal copy does. They are seeded once and
  never overwritten, so the first admin edit becomes the truth.

## M-17 Case Clarification

Lets a treating doctor get an expert opinion **without exposing the patient**.
Owns `clarification_cases`.

### Endpoints

| Method    | Path                                                 | Who                                   |
| --------- | ---------------------------------------------------- | ------------------------------------- |
| GET/POST  | `/doctor/clarification-cases`                        | any verified doctor (their own cases) |
| GET/PATCH | `/doctor/clarification-cases/:id`                    | that case's author                    |
| POST      | `/doctor/clarification-cases/:id/post`               | that case's author                    |
| POST      | `/doctor/clarification-cases/:id/reply`              | that case's author                    |
| POST      | `/doctor/clarification-cases/:id/reviewed`, `/close` | that case's author                    |
| GET       | `/doctor/expert-reviews`                             | the **assigned** expert               |
| GET/POST  | `/doctor/expert-reviews/:id`, `/:id/reply`           | the **assigned** expert               |
| GET       | `/admin/clarification-cases`, `/experts`             | clinical governance, operations       |
| POST      | `/admin/clarification-cases/:id/assign`              | clinical governance, operations       |

### De-identification is structural, not procedural

There is nowhere in `clarification_cases` to put a name, a phone number, an
address or an email. The snapshot carries an age and a gender, and neither
identifies anybody alone. Attachments are `patient_files` rows carrying a
`clarification_case_id`, and **M-10's CHECK forbids such a row a `patient_id`** —
so a case attachment cannot be joined back to a person even by mistake. None of
that can be got round by writing the wrong code.

What structure cannot reach is the **free text**. `brief_history` and
`specific_doubt` are prose written by a busy clinician, and "Mrs Sharma has been
calling me on 98765 43210" is one distracted sentence away.
[`deidentify.ts`](src/clarification/deidentify.ts) scans for the identifiers that
have a shape — phone numbers, emails, Aadhaar, links, long unexplained digit
runs — and **refuses rather than redacting**. Silently rewriting a clinician's
words would be worse than either alternative: they would not know what the
expert was actually shown, and a scanner good enough to trust with silent edits
does not exist.

It deliberately does not attempt names. A detector that fires on "the patient
reports Sunday was worse" trains people to click past it, and a warning people
click past protects nobody. There is a test suite of ordinary clinical
sentences — doses, PHQ-9 scores, blood pressures, admission years — asserting it
stays quiet on all of them.

The scan runs at **draft and again at post**. Those are not redundant: a case can
be edited between them, the patterns can be tightened between them, and post is
the last moment before the text becomes visible outside the treating
relationship. The error names the _field_ and the _kind_ and never the value —
echoing it back would put the identifier in a client error body and a log line,
two more places than it started in.

### Two independent checks, and the second is the one that matters

> FR-12.4: "Expert level decides who may be asked, and the assignment on the
> case decides what they may see. Eligibility alone never grants visibility."

- `doctors.seniority_level = expert` says **who may be asked**. Checked only
  where an admin is _choosing_ somebody, and re-checked at the moment of
  assignment rather than only when the list was drawn — a doctor can be
  suspended between the two.
- `expert_doctor_id` on the case says **what they may see**. Every expert read
  filters on it. An expert holding no assignment gets the same 404 a stranger
  would, and there is no listing that would tell them the case exists.

Assignment is an **admin's** decision, not the author's, so a treating doctor
cannot route their own case to a friendly colleague. Which admin chose is the
`audit_log` row rather than a column — it is a decision, not an attribute of the
case.

The reviewer's response is built by **naming every field** rather than by
deleting from the row, so `source_consultation_id` — the one link back to a
patient — is absent by construction, and a column added later stays absent until
somebody decides it belongs.

### Nothing here reaches the patient

FR-12.7, enforced by absence: there is no patient endpoint, no patient
notification and no patient-visible field anywhere in this module. Marking a
case `reviewed` records that the advice was _considered_; it never means it was
followed. The treating doctor owns all patient communication and remains
responsible for the plan.

### The thread is appended atomically

`messages = messages || $1` in the database, not read-modify-write in the
service. Two people replying within the same second is entirely ordinary on an
urgent case, and a read-modify-write would silently drop one of them — which on
a clinical thread means an expert's advice vanishing with no trace it was ever
given. The message and the new status are written in one statement, so a reply
can never land with the case left in the state it was answering.

The message **kind** drives the status, which is what makes the treating
doctor's queue meaningful: `clarification_request` puts the case back on their
desk, everything else puts an answer on it. Reading a paragraph to find out
which is not triage.

### Rules the schema enforces, not the code

- An assignment is an expert **and** a time, or it is neither — a time with
  nobody assigned puts a case in a queue no expert can see.
- A case cannot reach any expert-involving status without an expert.
- A doctor cannot be their own reviewer.
- `posted_at` set exactly when the case is out of draft; `closed_at` set exactly
  when it is closed. The timestamps **are** the facts, so they cannot disagree
  with the status beside them.
- `messages` is a jsonb array — `||` silently does the wrong thing on an object.
- An age between 0 and 120. A de-identified case is exactly where a typo goes
  unnoticed: there is no name beside it to look wrong.

`ON DELETE SET NULL` on the consultation, unlike `NO ACTION` on the two doctors:
if the consultation is erased under SRS 6.4 the case must survive **without** its
one link back to a patient, which leaves it in exactly the de-identified state a
reviewer always saw.

### Known gaps

- ~~Not yet run against a live database.~~ **Done.** Applied and verified: a
  case carrying a phone number refused, an eligible-but-unassigned expert given
  a 404, and all seven FR-12.6 states traversed with the thread intact.
- **Neither party is notified.** M-08 has no template for "a case was shared
  with you" or "there is a reply", so `tell()` logs instead of pushing. That is
  deliberate rather than an oversight: notification copy is M-08's to own and
  needs review before it goes in front of a clinician. Both parties see the case
  in their own list either way.
- **Attachments cannot be uploaded through this module.** The column, the
  foreign key and M-10's de-identification CHECK are all in place and the case
  view lists `attachmentIds`, but the de-identified _copy_ has to be made — the
  scrubbing of an uploaded file is M-10's, and it does not expose a "copy this
  file with the patient stripped" operation yet.
- **`expert` seniority is set directly on the doctor row.** M-05 owns that field
  and has no admin screen for promoting somebody to expert, so today it is a
  database update.

## M-18 Care Hub

The education and self-help library, and the mechanism by which a doctor
recommends from it. Owns `content_items`.

### Endpoints

| Method    | Path                                | Who                          |
| --------- | ----------------------------------- | ---------------------------- |
| GET       | `/care-hub/items`                   | patients and doctors         |
| GET       | `/care-hub/items/:slug`             | patients and doctors         |
| GET       | `/care-hub/emergency`               | patients and doctors         |
| GET/POST  | `/admin/care-hub/items`             | content, clinical governance |
| GET/PATCH | `/admin/care-hub/items/:id`         | content, clinical governance |
| POST      | `/admin/care-hub/items/:id/submit`  | content, clinical governance |
| POST      | `/admin/care-hub/items/:id/publish` | **clinical governance only** |
| POST      | `/admin/care-hub/items/:id/archive` | content, clinical governance |

### One table for seven kinds of content

A self-help tool, an education module, a blog, a caregiver guide, the emergency
guidance, an NGO listing and a specialty red-flag reference differ only in what
they are **for**. All have a title, a summary, a body and a review status, and
all move through the same authoring and clinical-review workflow. Seven tables
would be the same six columns copied seven times, and seven admin screens to
keep in step.

The `support_org` shape — phone, address, timings (FR-15.6) — lives in the jsonb
body rather than as seven mostly-null columns, with one exception:
`is_verified_org` is a real column, because FR-15.6 requires verification to be
**shown and filtered on**, and you cannot index a key buried in a body.

### Published is the only thing a patient ever sees

Every patient-facing read filters on `review_status = 'published'`, and a CHECK
refuses a published row with no named reviewer. FR-15.3's "clinician-reviewed"
therefore means somebody reviewed it, rather than being a claim in a paragraph —
and SRS 8 makes that somebody the client's clinician rather than the developer.

Two admin roles, deliberately split: `content` writes, `clinical_governance`
publishes. Those are different judgements made by different people, and
publishing stamps the reviewer's name and the time in the same write.

**Editing a published item sends it back to clinical review** and clears the
reviewer. The point of the review is that the words a patient reads are the
words a clinician approved; an edit that stayed published would leave the
sign-off attached to text nobody is reading any more.

Archiving never deletes. A doctor may have recommended an item last week, and a
Care Plan pointing at a row that no longer exists is a broken link on a screen a
patient was told to read.

### The port M-15 and M-16 had been waiting on

M-15 stored `recommendedContentIds` **unchecked** — a known gap while no library
existed. A typo, or an item archived since, put a broken link on a Care Plan and
nobody found out until the patient tapped it.

M-15 now declares [`CONTENT_LIBRARY`](src/clinical/content-library.ts) with a
deliberately **closed default**: nothing is recommendable, nothing resolves. A
missing dependency must refuse, never wave things through — so a deployment
without M-18 stores no unverifiable ids at all. M-18 binds the same token and
opens it, exactly as M-11 closed the four ports M-04, M-05, M-07 and M-10
declared. Nothing in M-15 or M-16 changes; both go on calling the port.

The two halves behave differently on purpose:

- **`unrecommendable`** counts only `published`. A draft is unfinished, one in
  review is not approved, and an archived item was retired — recommending any of
  the three would put a patient in front of content nobody signed off. It returns
  the offending ids rather than a boolean, so a doctor drops one pick instead of
  losing the whole selection.
- **`summaries`** does _not_ filter on status, and resolves archived items too. A
  recommendation from last week should not vanish because the library was tidied
  since. Ids that resolve to nothing are simply absent — four of five
  recommendations beats a Care Plan that fails to load.

Summaries come back in the order the **doctor** picked them, which is clinical
intent, not the order the index happened to give.

### Emergency guidance never fails

FR-15.7 and SRS 6.3 make it persistent and reachable from everywhere.
`emergencyGuidance()` returns a **list** and never throws when it is empty, so
the app falls back to built-in copy. The alternative is an error on the one
screen somebody in crisis is looking at. An empty result is logged as a warning,
because it means nobody has published it yet.

### No ownership check anywhere, and that is correct

This library holds no clinical data and belongs to no patient — a breathing
exercise is the same breathing exercise for everybody. The routes are
authenticated because an app with no session has nowhere to show them, not
because the content is private. It is open to doctors as well as patients,
because a doctor picking items to recommend (FR-15.4) is reading the same shelf
the patient will.

FR-15.8: no comments, no likes, no forum. There is no peer-content table because
there is no peer content.

### Rules the schema enforces, not the code

- Nothing is `published` without a named reviewer **and** a review time.
- A reviewer and a review time arrive together or not at all.
- `is_verified_org` is non-null **exactly** for `support_org` — verification is
  meaningless on a blog post, and a NULL elsewhere is what makes "verified" and
  "not verified" the only two answers for a listing.
- `body` is a jsonb object, not an array or a bare string.
- A slug is lowercase words separated by single hyphens, because it goes into a
  link. Checked in the service too, so the panel gets a sentence rather than a
  constraint violation.

`ON DELETE SET NULL` on the concern and the specialty: retiring a concern must
not delete the articles written about it. An unshelved article is still worth
reading, and a doctor may have recommended it.

### Known gaps

- ~~Not yet run against a live database.~~ **Done.** The migration is applied and
  the flow is verified end to end — see the M-20/M-21 section for the module-
  binding bug that live run found.
- **No content is seeded.** Unlike M-16's pathways, nothing ships: FR-15.1 to
  FR-15.7 name the _categories_ but every word is clinical content the client's
  clinician authors and signs off under SRS 8. Shipping placeholder self-help
  instructions felt worse than shipping none — a breathing exercise a patient
  follows in a panic attack is not something to invent. **The library is empty
  until the client writes it**, which means `/care-hub/emergency` returns `[]`
  and the app must show its built-in fallback.
- **Cover images have no upload route.** `cover_storage_key` is on the row and
  the storage service can sign an upload, but the admin flow for putting a cover
  in the object store is not wired — the same server-side-put gap that blocks
  M-15's prescription PDF.
- **M-06's red-flag references are not migrated.** `clinical_reference` exists as
  an item type and shelves by specialty, but nothing moves M-06 to reading them
  from here.

## M-19 Feedback and Complaints

Collects what patients think and resolves what goes wrong. Owns `complaints`;
writes M-11's two feedback columns.

### Endpoints

| Method   | Path                                               | Who                             |
| -------- | -------------------------------------------------- | ------------------------------- |
| PUT/GET  | `/me/consultations/:id/feedback`                   | that patient                    |
| GET/POST | `/me/complaints`                                   | that patient                    |
| GET      | `/me/complaints/:id`                               | that patient                    |
| POST     | `/me/complaints/:id/reply`                         | that patient                    |
| GET      | `/admin/feedback`                                  | operations, clinical governance |
| GET      | `/admin/complaints`, `/complaints/:id`             | operations, clinical governance |
| POST     | `/admin/complaints/:id/assign`, `/reply`, `/close` | operations, clinical governance |

### Feedback gets no table

A rating has no workflow, no thread and no assignee — it is submitted once and
read in aggregate. So it is `feedback_rating` and `feedback_comment` on the
consultation it is about, exactly as M-11 declared them. A complaint has all
three, which is why that is a table.

Feedback is only accepted once the consultation **actually happened** —
`in_progress`, `awaiting_documentation` or `completed`, never a cancellation or
a no-show. FR-18.6 reads these as evidence about a named clinician, so what goes
into them matters more than making the button always work.

The rating goes into the audit trail; the **comment does not**. The comment is
the patient's own words about a named clinician, and the audit log is read by
more people than the feedback screen is.

### The internal note is the whole design problem

An admin working a complaint needs somewhere to write _"spoke to the provider,
they dispute this"_ while it is open. Without that, the thinking happens in
email — invisible to whoever picks the ticket up next. So it goes on the ticket
as a message with `isInternal`, and the patient must never see it.

Two things make that safe rather than hopeful:

- The patient's view is a **positive filter** — keep what is explicitly
  `isInternal === false`. A `filter(m => !m.isInternal)` would _keep_ an entry
  whose flag was missing or the wrong type. When the failure mode is "the patient
  reads the admin's private note about them", the filter has to fail towards
  showing too little, and there are four tests for exactly that.
- A patient's own message **can never** be internal, because the service sets
  the flag rather than the caller. There is no request shape that could ask for it.

Internal notes are **absent** from the patient view, not blanked. A redacted
entry would still tell the patient that an admin wrote something private about
them at 14:32 on Tuesday, which is its own kind of unpleasant. The admin view is
built by _adding_ to the patient's, so the two cannot drift apart — the override
that restores the full thread is one line and deliberately visible.

The **fact** that an internal note was written is audited; its contents are not.

### Rejected is not resolved

`resolved` means something was done. `rejected` means it was considered and
declined — a different outcome, and one the patient is owed as a distinct answer
rather than as silence. `resolved_at` is set **only** on a resolution, and a
CHECK holds the two apart, so FR-18.6's "how many did we resolve" stays
answerable.

Both endings need a **note** and an **owner**. A patient told only "rejected"
has been dismissed rather than answered, and somebody has to stand behind the
decision — whoever closes an unclaimed ticket becomes its owner, which is more
honest than refusing the close and making them click assign first.

Assigning also moves `open` to `in_progress`: a ticket somebody has taken
responsibility for is being worked, and two clicks to say one thing produces
queues full of assigned-but-open tickets nobody trusts.

A patient cannot reply to a closed complaint. That is not silencing them — a
reply to a decision is an escalation, and an escalation that looks like a reply
on a closed ticket is one nobody is watching. A new complaint queues where
somebody will see it.

### `CX-`, not `CC-`

The ticket number a patient quotes to support. [`reference-code.ts`](src/booking/reference-code.ts)
now takes a prefix over the same alphabet — the one with no `0`/`O` and no
`1`/`I`/`L`, so the characters people always mishear cannot occur. Two prefixes
over one shared alphabet means whoever takes the call knows whether they have
been given a consultation or a complaint without asking, and the no-mishearing
rule holds for both.

The thread is appended with `messages || $1` in the database, not
read-modify-write. A patient replying while an admin writes an internal note is
entirely ordinary, and a read-modify-write would drop one of the two silently —
losing either the patient's words or the note explaining a decision.

### Rules the schema enforces, not the code

- `resolved_at` is set **exactly** when the status is `resolved` — never for a
  rejection, never absent from a resolution.
- Both terminal states carry a non-empty `resolution_note`.
- Neither terminal state can be reached without an assignee.
- `messages` is a jsonb array — `||` silently does the wrong thing on an object.
- The reference code matches `CX-` plus two blocks of the mishearing-safe
  alphabet.

`ON DELETE CASCADE` on the patient — a complaint is written in their own words
about their own care and goes with them under SRS 6.4. `NO ACTION` on the
consultation, because a complaint about one is frequently the evidence behind a
refund and must not disappear when the appointment is tidied away.

### Known gaps

- ~~Not yet run against a live database.~~ **Done.** Applied and verified,
  including the internal-note boundary and both terminal outcomes.
- **Nobody is notified.** M-08 has no template for "your complaint was updated"
  or "a complaint was assigned to you", so the queue is the only place either
  side learns something moved. The copy is M-08's to own and needs review before
  it goes to a patient who is already unhappy.
- **No SLA or ageing.** The queue orders by age, but nothing escalates a
  complaint nobody has touched. No FR asks for it; worth raising with the client
  if operations expect one.
- **Feedback cannot be withdrawn.** A patient can revise a rating (the endpoint
  is a PUT) but not remove it. Nothing in the SRS says either way.

## M-20 Governance and Quality

The admin's operational and clinical control room. **Owns no tables.**

### Endpoints

| Method | Path                                       | Who                                               |
| ------ | ------------------------------------------ | ------------------------------------------------- |
| GET    | `/admin/governance/dashboard`              | operations, clinical governance, care coordinator |
| GET    | `/admin/governance/pending-case-summaries` | operations, clinical governance, care coordinator |
| GET    | `/admin/governance/provider-quality`       | operations, clinical governance                   |
| GET    | `/admin/governance/allocation-decisions`   | operations, clinical governance                   |
| GET    | `/admin/governance/export/:kind`           | operations, clinical governance                   |

### Owning nothing is the design

M-20's completion criterion is that **every number reconciles with the owning
module's data**, and the only way to guarantee that is to have no numbers of its
own. There are no counters here, no nightly rollup and no summary table — a
dashboard figure cannot disagree with its source because it _is_ its source,
counted at the moment it is asked for.

That costs eighteen counts per dashboard load. It buys the one property a
control room needs: when an admin says "this says twelve" and a clinician says
"I can only find eleven", they are looking at the same rows.

Verified live by reading every figure back out of Postgres directly — completed
consultations, resolved and rejected complaints, closed clarifications, active
follow-ups and check-ins all matched exactly.

Safety alerts are counted **open regardless of the date window**. An unclosed
red flag from last month is still somebody's problem today, and a queue that
hides it behind a filter is a queue that loses people.

Reliability figures are read through M-05's registry rather than counted here,
so the dashboard and a provider's own profile show the same number. Two
implementations of one figure is two figures.

### The two rates that had been null since M-11

`acceptanceRate` needed M-13's `instant_consultancy` and `caseSummaryCompletion`
needed M-15's `clinical_records.finalised_at`. Both existed by now, so
[`booking.adapters.ts`](src/booking/booking.adapters.ts) completes them — where
the port's own documentation says they belong.

The denominators are where the judgement is:

- **`superseded` is not a decline.** A provider still deciding when somebody
  else accepted first did not refuse. Counting it against them would penalise
  being on a busy rota and make the fastest tapper look like the most reliable
  clinician. Proven live: 1 accepted out of 1 declined + 1 timed out + **3
  superseded** + 1 pending reports **0.333**, not 0.143.
- **Case summaries are counted out of `completed` only.** One still awaiting
  documentation is not late paperwork — the doctor may be writing it now, and
  counting it as a miss makes the figure worse the busier the clinic is.
- **Every rate is null rather than zero on an empty denominator.** A provider
  offered nothing has not failed to accept anything, and 0% on a dashboard read
  as evidence about a named clinician is a false accusation.

### The CSV export guards against formula injection

A cell beginning `=`, `+`, `-` or `@` is **executed as a formula** by Excel and
Sheets. These exports carry patient-written text, so somebody can type
`=HYPERLINK("http://evil","Click")` into a complaint and have it run on an
admin's machine. [`csv.ts`](src/governance/csv.ts) prefixes such a cell with an
apostrophe, which makes it literal text, is invisible in the spreadsheet, and
costs nothing. Verified end to end: a formula typed into a real complaint
arrives in the file as `"'=HYPERLINK(...)"`.

Complaint **bodies and message threads are deliberately excluded** from the
export. Those are the patient's own words about a named clinician, and an export
is a file that gets emailed around.

Nothing is aggregated on the way out. An export is evidence, and one that has
already done the arithmetic cannot be checked against anything.

---

## M-21 Audit, Compliance and Data Rights

Proving who saw and changed what, and honouring data requests. **Owns no tables.**

`audit_log` is M-01's, because every module writes to it from its first release.
Retention is an `app_config` value. Deletion evidence is columns on M-03's
request row. This module owns the _behaviour_ over all three.

### Endpoints

| Method | Path                                              | Who                             |
| ------ | ------------------------------------------------- | ------------------------------- |
| GET    | `/admin/compliance/audit`                         | every admin level, narrowed     |
| GET    | `/admin/compliance/audit/export`                  | every admin level, narrowed     |
| GET    | `/admin/compliance/audit/consultation/:id`        | operations, clinical governance |
| GET    | `/admin/compliance/retention`                     | any admin                       |
| POST   | `/admin/compliance/retention/apply`               | **super admin only**            |
| POST   | `/admin/compliance/deletion-requests/:id/execute` | **super admin only**            |

### Least privilege, applied to the table that describes everything

`super_admin` reads the whole trail; every other level reads only the entity
types its own work covers. That is not secrecy — it is the same rule the rest of
the panel runs on. A content editor reading the trail of a clinical record would
be a wider view of clinical activity than their own screens give them.

Verified live against three real accounts:

```
super_admin  35 kinds — clinical_record, payment_webhook, safety_alert, …
content       3 kinds — app_config, content_item, legal_document
finance       4 kinds — app_config, consultation, payment_webhook, service
```

**Searching the log is itself logged.** Reading who saw what is a privileged
act, and a trail that does not record its own readers cannot answer the question
it exists for. The _query_ is recorded, never the results — copying those would
double the log every time somebody looked at it.

### The retention sweep cannot be aimed

`applyRetention` deletes **by age and only by age**. It takes no filter: not an
actor, not an entity, not a date range of somebody's choosing. A sweep that
could be aimed is a way to erase one inconvenient entry, which is exactly what
an audit log exists to prevent. It is super-admin only, because retention is a
legal decision rather than an operational one, and it writes its own entry — so
the trail records that a slice of the trail was retired, and when.

There is no method in this module that edits an entry. An audit trail somebody
can edit is not an audit trail, so "delete this embarrassing entry" is not an
operation that exists.

The default is **2920 days (eight years)**, deliberately the safe end: an entry
deleted too early cannot be recovered, while one kept too long is a storage cost
and a config change. SRS 5.3 makes the real figure the client's counsel's to set.

### Erasure, and what survives it

M-03 takes the request and an admin approves it; M-21 runs it — as M-03's own
comment anticipated ("M-21 owns the run; this is where its result lands").

The erasure is almost entirely the **database's** work: `patients` is the root
and the foreign keys decide what follows, which is what all the `ON DELETE`
care in earlier migrations was for. Counts are taken _before_ the delete, because
afterwards there is nothing to count, and they become the evidence in the
outcome record.

What is retained is **named explicitly with its ground** — payments under
statutory accounting obligations, the audit trail for the retention period, and
clarification cases which were already de-identified. A subject access request
asks what was kept, and "nothing, probably" is not an answer.

**The patient id survives in the audit trail on purpose.** Erasing the evidence
that an erasure happened would make the obligation unprovable, which is the
opposite of what SRS 6.7 keeps the log for.

A failure writes its reason into the **same** outcome record — which is why M-03
has no separate failure column. A failure is an outcome, not a different kind of
thing.

### Verified live

M-21's completion criterion, checked against a real consultation: **54 audit
entries**, spanning a video join token, a clinical record write, a follow-up
assignment, a safety alert raised and acknowledged, feedback, and a complaint
created and updated — every one carrying actor, target and time.

### The retention sweep is scheduled, and ships OFF

[`retention-sweeper.service.ts`](src/compliance/retention-sweeper.service.ts)
runs nightly — and is the **only** sweeper in this codebase that ships disabled.
The others do recoverable things: a slot released early can be rebooked, an alert
raised twice can be closed. This one deletes audit entries, and an entry deleted
is gone. Until the client's counsel has signed the retention period off, the
shipped default is a guess, and a guess that silently erases evidence on a
schedule is not a default anybody should inherit. A super admin turns it on in
`app_config` once the figure is confirmed — and can run the sweep by hand first
and read the count.

Daily rather than hourly, the opposite call from M-16's check-in sweep and for
the opposite reason: a missed check-in hour costs a seventh of somebody's
follow-up, while a missed retention day costs nothing, because an entry that was
eight years old this morning is eight years and a day old tomorrow. Running an
irreversible operation rarely is the conservative choice.

**A scheduled sweep is attributed to `system`, not to a person.** There are two
entry points — `applyRetention(actor)` and `applyRetentionAsSystem()` — rather
than one with a fabricated actor, because "who deleted these entries" must not
answer with the name of whichever admin happened to be configured. Nobody
clicked it, and a trail that implies somebody did is worse than one that says
nothing. The audit entry carries `scheduled: true`/`false` to tell them apart.

### Subject access: everything held about one person

`GET /me/data-export` for the patient themselves, and
`GET /admin/compliance/patients/:id/data-export` for an admin answering a written
request. The counterpart to erasure — a data-rights regime that can delete but
cannot show is half a regime.

Super admin only on the admin route: it is the single widest read of one
person's data in the platform, so the level that can perform it is the level
that can also authorise an erasure. The patient route takes no id at all, so
there is no shape of request in which one person could name another.

Files are listed by **name and date, never by storage key** — a key in a document
that gets emailed around is a durable pointer to a private record, and files
download from the patient's own account through a link that expires. Files the
patient already deleted are left out: a document they removed is not data the
platform still holds, and listing it would answer the question wrongly in the
direction that alarms people.

**What is left out is named in the document itself**, under `notIncluded`, with
the reason:

| Omitted                  | Why                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Complaint internal notes | Whether staff notes form part of a subject access response is a question for the operator's legal advice |
| Clarification cases      | De-identified before sharing; nothing in them can be attributed to the patient                           |
| The audit log            | Producible on request, but it names staff as well as the patient                                         |
| File contents            | Listed by name; downloaded from the patient's own account                                                |

Each is a decision the client's counsel should confirm rather than one this
module makes quietly. Handing over everything about somebody is itself recorded
— in shape, never in content, because copying the export into the trail would
double every record it contains.

### Known gaps

- ~~`app_config` has no admin editing endpoint.~~ **Built** — see _The settings
  screen_ below.
- **No downloadable file format for the subject access export.** It returns JSON.
  A person exercising a data right usually wants something they can open, which
  probably means the same PDF work M-15's prescription is waiting on.
- **The dashboard has no per-provider or per-specialty breakdown.** FR-18.6
  names the figures, not the slicing; the queries are simple to extend when the
  panel design says how.

---

## The settings screen (M-01)

`GET /admin/config` and `PUT /admin/config/:key`, behind FR-7.5, FR-13.7 and
FR-16.3's "configurable from the admin panel". Nineteen values were seeded and
carefully documented across eleven modules, and until now nothing exposed any of
them — changing a GST rate meant a database update.

### The registry assembles itself from the modules that own the values

Nothing here is a constant in `app-config.service.ts`. Every entry is put in the
registry by the module that seeds it, **in the same call**, so a key, its shape
and its permission cannot drift apart:

```ts
await this.config.seed([
  {
    key: GST_PCT_KEY,
    value: DEFAULT_GST_PCT,
    description: 'GST as a percentage, charged EXCLUSIVE on the subtotal…',
    schema: z.number().min(0).max(100),
    editableBy: ['finance'],
  },
]);
```

A value nobody registered cannot be edited — nothing reads it, so changing it
would do nothing, and offering it would imply otherwise. The registry is in
memory rather than in a table because it describes **code**: which module reads
the value and what it expects. Storing it would let the description of a value
disagree with the code reading it.

### Three gates, and the third is the one that matters

1. **The key must be registered.** Unknown keys are a 404.
2. **The admin's level must own it.** A per-key list, not one blanket
   permission, because these values are not equivalent: a GST rate is finance's,
   a red-flag threshold is clinical governance's, and the audit retention period
   is nobody's but a super admin's. Verified live — finance can change GST and
   not the join window; a content editor can change neither.
3. **The value must be the shape the reading module expects.** A config table is
   the easiest place in a platform to put a string where a number goes and not
   find out until the next checkout fails for every patient.

Where a schema already existed it is **reused, not copied** —
`emergencyGuidanceSchema`, `forbiddenTermsSchema`, `RATE_LIMIT_SCHEMA`,
`REQUIRED_DOCUMENTS_SCHEMA` are the same objects the reading code validates
with, so there is one definition per value rather than two that drift. Writing
this caught two of my own guesses being wrong: `search.emergency_guidance` is a
structured object, not a string, and the baseline document list is an enum
array. The registry now rejects a bogus document type and names the offending
field:

```
✖ Invalid input: expected string, received undefined  → at message
✖ Too small: expected array to have >=1 items         → at helplines
```

### Values with their own screen are listed, not editable

Five of the nineteen — the allocation policy, notification templates, crisis
keywords, search synonyms and the disclaimer — have dedicated admin screens that
validate more than a shape check can (a template's placeholders, for instance).
Those carry `managedBy`, so this endpoint lists them, refuses to edit them and
says where to go. Two ways to change one value is how the two drift apart.

Every change is recorded with the before and the after. That audit entry **is**
the configuration history, which is why there is no versions table.

### Known gaps

- **A `PUT` on a partial object replaces the whole value.** `identity.rate_limits`
  is a partial schema, so writing `{admin_login: …}` drops the other flows — the
  reader falls back to its defaults, so nothing breaks, but an admin panel should
  send the complete object rather than a patch. Worth a note in the panel's UI.
- **No preview of what a change affects.** Lowering the acceptance window changes
  routing behaviour immediately for anyone mid-request. The values are all
  small-blast-radius today, but a confirmation step naming what a setting drives
  would be worth having before launch.
