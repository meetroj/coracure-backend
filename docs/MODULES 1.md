# Module Plan

## Doctor Consultation Platform

Version 1.3
Date: 1 September 2026
Prepared by: Synquic
Source documents: SRS.md version 1.2, the approved database design in
`db/schema.dbml`, and the Synquic Proposal dated 4 August 2026

Version 1.3 carries the client instructions of 1 September 2026: the patient no
longer chooses their provider, allocation is configured from the admin panel on
language, region and available duration, and providers register on one of two
forms. The twenty one modules and their build order are unchanged; what moves is
what M-06 owns and where assignment is decided. Changes are listed in section 8.

---

## 1. Purpose

- Split the platform into modules that can be built one at a time.
- Each module states what it does, what it stores, what it needs first, and when it is finished.
- Modules are built in order. The next one starts only after the current one is complete and tested.
- Module boundaries follow business domains, so a module can later run as its own service without a rewrite.

---

## 2. Applications

- Patient app: React Native, patient accounts only, published as its own store listing.
- Doctor app: React Native, doctor accounts only, published as its own store listing. Expert doctors sign in here like any other doctor.
- Admin web panel: React.js.
- One backend serves all three. Every endpoint is role-scoped, and each app accepts only its own roles at sign-in.
- Shared API client, types and common components live in one package used by both apps, so behaviour stays consistent without sharing navigation or screens.
- A module is done only when its work is delivered in every app it touches.

---

## 3. User Types

Three kinds of account, each in its own table. The table an account lives in is
its role. There is no shared user record and no role column.

- Patient: signs up with a mobile OTP and never has a password, books and pays, attends the consult, follows the care plan and check-ins, sees only their own records.
- Provider: covers psychiatrists, psychologists, therapists and counsellors. Never self-registers. An admin creates the account, the provider uploads credentials, an admin approves each credential separately, then approves the provider and lists them. Sets availability, runs consults, writes notes and either a medicine prescription or an advice and therapy plan, sees only their own patients. Registered on one of two forms - **doctor** or **non-doctor healthcare provider** - and which form is used follows from the specialty, not from a field on the provider record. Both are the same kind of account in the same `doctors` table; see SRS 14 for the naming decision still open.
- Admin: created by another admin, signs in by email and password. Runs the web panel for doctors, specialties, appointments, payments, content and configuration, limited by permission level.

Three types named in version 1.0 are not separate accounts:

- Expert doctor is a level on the doctor record, granted and revoked by an admin. It makes a doctor eligible to be asked for an opinion. Sight of a case still requires that case to be assigned to that expert.
- Care coordinator is an admin permission level, not an account type.
- Service account is removed. The payment gateway webhook has no identity; it is authenticated by HMAC signature on the raw request body.

---

## 4. When a Module Is Done

- Every listed feature works end to end against the real database.
- Role and ownership checks are enforced on every endpoint.
- Unit tests cover the rules, integration tests cover the main paths.
- Migrations are written, applied and repeatable on a clean database.
- The module's public interface is defined and used, with no reach into its internals.
- Configuration comes from the environment or admin settings, never from code.
- Audit entries are written where the module touches clinical or financial data.

---

## 5. Modules

Twenty one modules, in build order.

### M-01 Platform Foundation

Purpose: The base every other module stands on.

Features:
- Environment configuration with fail-fast validation at boot
- Database connection, pooling and migration setup
- Standard error shape and handling for all endpoints
- Shared authorisation checks for role and ownership
- Encryption in transit and at rest, HTTPS throughout
- Audit entry writer used by every module
- Shared event mechanism so modules react without direct coupling
- Configuration held as data, not code

Data owned: `app_config`, `audit_log`. Config history lives in the audit log, not a separate versions table.
Depends on: nothing.
SRS: 5.2, 6.1, 6.6, 6.7, 7.
Done when: the service boots, connects, rejects a bad configuration, and writes an audit entry.

### M-02 Identity and Access

Purpose: Prove who a user is and enforce what their role allows.

Features:
- Patient self sign-up by mobile number and OTP, with no password
- Admin accounts created by another admin, signing in by email and password
- Doctor accounts are created here in shape but owned by M-05, which holds the registration and verification state
- Each app accepts only its own kind of account; a sign-in against the wrong app is refused with a plain message
- Ownership checks on every request
- Login expiry and revocation, with current authentication state held on each account row and push-device state on the patient and doctor rows only
- Rate limiting on OTP issue, OTP verification and admin login, enforced from the audit log. OTP challenge state belongs to Slide, not this platform
- Optional two-factor authentication on admin accounts, using a Slide OTP challenge after the password
- Expert level is granted and revoked by an admin on the doctor record in M-05

Data owned: `patients`, `admins`; each account table owns its current login state as one `token_version`. Push-device state (`push_token`, `device_id`) is on `patients` and `doctors` only - SRS 2.3 puts the admin panel in a desktop browser, so admins have neither and read their alerts in-panel from `notifications`. OTP challenge state is held by Slide. Login attempts are audit-log entries, not their own table. Doctor accounts belong to M-05.
Depends on: M-01.
SRS: 4.1, 6.1, 6.2.
Done when: each user type signs in through its own path, and no user can read another user's records.

### M-03 Consent and Legal

Purpose: Capture and prove consent, and serve legal text in the app.

Features:
- Explicit teleconsultation consent before the first consultation
- Consent version, timestamp and user recorded
- Privacy policy, terms of use, refund and reconsult policy shown in the app
- Data deletion request workflow with status

Data owned: `legal_documents`, `consents`, `data_deletion_requests`. The deletion request also carries its own execution evidence.
Depends on: M-01, M-02.
SRS: 4.2, 6.2.
Done when: no consultation can start without a recorded consent, and consent version and time are retrievable.

### M-04 Patient Profile

Purpose: Hold the patient's own details.

Features:
- Basic profile of name, age, gender, contact, language and region
- Profile edit
- Profile read by other modules through this module only
- Preferred language and region are the two fields assignment matches on (SRS 4.20), so this module is where they are captured and kept current

Data owned: nothing of its own. The patient profile is columns on the `patients` row owned by M-02. This module is the read and edit interface other modules go through. Version 1.3 adds `region_id` to that row; it points at M-06's `regions`.
Depends on: M-02. M-04 is built before M-06, so `patients.region_id` arrives as a plain column and M-06 adds its foreign key with the `regions` table - the same order M-03 took for `consents.doctor_id` and M-05 completed.
SRS: 4.2, 5.1, 20.10.
Done when: a profile is readable only by its owner and by a doctor assigned to that patient.

### M-05 Doctor Registry and Verification

Purpose: Hold doctor accounts, credentials and permissions.

Features:
- Admin creates the provider account on one of two registration forms, doctor or non-doctor healthcare provider; there is no self sign-up path on either
- The form, the credentials demanded and prescribing rights all follow from the specialty, so adding a non-doctor specialty needs no code change (SRS 19.7)
- Provider uploads credentials, and an admin approves or rejects EACH document separately with a reason
- A doctor becomes verified only when every credential their specialty requires is approved
- A doctor is bookable only when verified and listed, which are two separate admin actions
- Registration certificate expiry is NOT tracked this release. No FR asks for it, and confirming that a registration is current is the client's obligation under SRS section 8. `doctor_documents` holds no `expires_on`
- Admin suspends or removes doctors
- Profile fields: qualification, registration number, experience, languages, one specialty, consultation duration and buffer
- Prescribing eligibility taken from the doctor's specialty: a psychiatrist prescribes medicines, while a psychologist, therapist or counsellor issues advice and a therapy plan only
- Fee setting per doctor. **Under review:** SRS FR-7.8 moves the fee to the specialty, because a patient who cannot choose the provider has to be quoted a price before the provider is known. Until the client confirms, the column stays and the specialty fee overrides it
- Region pool membership, maintained by an admin: which regions a provider serves (SRS 18.9)
- Instant-consult permission
- Expert role assignment
- Reliability metrics: acceptance rate, no-show rate and case summary completion, counted on demand from consultations and instant consultancies rather than stored as counters

Data owned: `doctors`, `doctor_documents`, `doctor_regions`. Verification state, fee, expert level and live presence are all columns on the doctor row. The languages a provider speaks are already on that row, so language pools need no table; regions do, because a provider serves several and each is a row an admin adds or removes. The registration form and prescribing eligibility are NOT here - they are on the specialty (M-06), because a copy here could disagree with it. Reliability metrics are NOT stored; they are counted from `consultations` and `instant_consultancy` when the dashboard asks.
Depends on: M-01, M-02, and M-06 for the specialty and region catalogues.
SRS: 4.1, 4.18, 8, 19.7, 20.3.
Done when: an unapproved provider cannot use the provider experience, permission changes apply without a release, and a provider can be put into and taken out of a region pool from the panel.

**Removed in version 1.3.** M-05 no longer serves a patient-facing provider directory. `GET /doctors` and `GET /doctors/:id` as a browsable, filterable, sortable list are gone: SRS 4.2 makes the patient's view of a provider the outcome of an assignment, so the profile read is now by assigned consultation, and the roster is admin-only.

### M-06 Catalogue, Specialty and Allocation Configuration

Purpose: Keep specialties, concerns, regions and the allocation policy as data, so new specialties, new regions and a changed matching rule need no new build.

**Widened in version 1.3.** M-06 was the specialty catalogue. It is now also the
catalogue that assignment matches against, which is why regions and the
allocation policy live here rather than beside the code that runs them.

Features:
- Add, edit and disable specialties from the admin panel
- Each specialty declares its registration form, doctor or non-doctor healthcare provider (SRS 19.7). That declaration is what decides which credentials M-05 demands and whether a medical council registration number is required
- Concern taxonomy per specialty
- Specialty-wise intake forms, including the medical history asked before a first consultation
- Specialty flag for whether that specialty may prescribe medicines. Correlated with the registration form at launch but kept separate: prescribing is a clinical permission, the form is a professional category, and the client may yet want a doctor specialty that does not prescribe
- Specialty-wise list of the credentials a provider of that specialty must submit, used by M-05 verification
- Specialty-wise consultation fee (SRS 7.8). This is what the patient is charged, quoted before a provider is assigned. What each provider is PAID stays on the provider row and is M-05's
- Add, edit and disable regions from the admin panel (SRS 19.8). A region is a row, not an enum, so a new one is an admin action
- The allocation policy as configuration: how ties are broken across a pool, how many times a patient may decline an assignment (SRS 4.4), and the default of spreading work evenly (SRS 20.6). Region is a preference the policy may relax; language never is
- Specialty-wise red-flag references, held as `content_items` rows with `item_type = 'clinical_reference'` and a `specialty_id`, owned by M-18
- Publish and disable from the panel. Neither `specialties` nor `concerns` nor `regions` carries a version column - who changed what, and when, is the `audit_log` row
- Specialty-wise prescription and therapy-plan templates are deferred; see SRS section 11

Data owned: `specialties`, `concerns`, `regions`. The intake form, the first-consult history block, the registration form, the prescribing flag and the list of credentials a specialty requires are all columns on the specialty row. Concern search phrases are columns on the concern row. The allocation policy is a value in `app_config`, owned by this module. `doctor_regions` is NOT here - which regions a provider serves is an attribute of that provider, so M-05 owns it, exactly as it owns `doctors.specialty_id` while M-06 owns `specialties`.
Depends on: M-01, M-02.
SRS: 2.4, 4.18, 4.19, 4.20, 7.8.
Done when: a new specialty of either registration form, with its form, its credential list and its fee, changes booking, verification and prescription behaviour with no code change; and a new region can be added and populated from the panel.

**Client decisions settled 1 September 2026** (SRS 14): the fee is per specialty,
region is a relaxable preference, a region is a state or province, and a patient
may decline an assignment a configured number of times. Nothing here is blocked.

### M-07 Availability and Scheduling

Purpose: Decide when each doctor can be booked.

Features:
- Weekly and date-wise slot setup
- Consultation duration and buffer time
- Blocked dates and leave
- Slot generation and lookup
- Conflict prevention on the same slot
- Remaining available DURATION at a given moment, not merely whether the provider is free at its start (SRS 10.7). A provider with ten minutes left before their next booking is not assignable to a thirty-minute consultation, and this is the module that can say so
- Admin edit of a provider's availability, so an absent provider can be taken out of the pool without waiting for them to update their own diary

Data owned: `doctor_availability`, one table covering the weekly pattern, blocked dates, leave and date overrides. There is NO generated slots table; bookable slots are computed from availability minus existing consultations.
Depends on: M-05.
SRS: 4.4, 4.10, 20.2.
Done when: two patients cannot take the same slot, blocked dates never appear as bookable, and the module can answer "how long is this provider free for, from this moment" for every candidate in a pool.

### M-08 Notifications

Purpose: Send every reminder and alert, in wording the admin controls.

Features:
- Push through Firebase Cloud Messaging and APNs, plus in-app reminders
- Separate push credentials per app, since the patient and doctor apps are separate store listings
- Patient notifications: booking confirmed, consult reminder, doctor joined, prescription ready, check-in due, report requested by the doctor
- Doctor notifications: instant requests, red-flag and amber alerts, pending documentation, report uploaded by the patient
- Admin notifications target the responsible admin account and are read in the panel, not pushed
- Notification copy editable from the admin panel
- Rule enforced that no notification names a diagnosis

Data owned: `notifications`, one row per recipient with exactly one of `patient_id`, `doctor_id` and `admin_id` set. Copy templates are a value in `app_config`. Patient and doctor notifications resolve the current `push_token` and `device_id` from that account row; an admin row has no push token and is read in the panel.
Depends on: M-01, M-02.
SRS: 4.16, 4.18, 6.2.
Done when: other modules raise notifications without knowing the delivery channel, and copy changes need no app release.

### M-09 Search and Concern Mapping

Purpose: Turn everyday language into the right professional type and concern, with a stated reason. Positioned as navigation, never as diagnosis.

**Changed in version 1.3.** The output is a service, not a shortlist of people.
SRS 5.1 and 5.4 now return specialties and concerns, because the patient does
not choose a provider - what this module produces is the input to assignment.

Features:
- Symptom search in plain words, typed or spoken, in English, Hindi or mixed input, with synonyms and informal phrasing
- Mapping to the concern taxonomy: depression, anxiety, sleep, OCD, substance use, psychosis, child and adolescent, women's mental health, elderly care
- Browse or search directly by professional type
- Ranked results with a plain-language reason, the fee for that service and the soonest time the pool can cover it. Never a named provider with their own fee and diary
- Optional concern guide for the unsure, never forced before booking
- Crisis guardrail that interrupts booking and shows emergency guidance
- Recent searches held on the patient device, and an admin-edited popular searches list held in configuration
- Reachable from the home search and from an assistant entry on patient screens
- Mapping, synonyms and crisis keywords editable from the admin panel
- Stated in the interface that this does not screen, diagnose or decide treatment

Data owned: nothing of its own. Mapping phrases are columns on `concerns` owned by M-06. Crisis keywords and popular searches are values in `app_config`. Recent searches are held on the device. Query logging is out of scope; see SRS section 11.
Depends on: M-06, M-07. M-05 is no longer a dependency: this module names a service, and never reads the provider roster to rank people.
SRS: 2.4, 4.5, 8.
Done when: a mixed-language query returns explained matches, a crisis phrase returns emergency guidance instead of results, and an admin edit changes behaviour with no release.

### M-10 Documents and File Storage

Purpose: Hold the patient's medical history and every report, photo and generated PDF, under access control.

Features:
- Medical history uploaded before the first consultation, held against the patient rather than one booking
- Patient uploads reports and photos against a booking, before or after the consult
- Doctor raises a report request in any session, naming what is needed and why
- Patient sees open requests and uploads against the request, so the file arrives labelled
- Request states: open, fulfilled, cancelled. The raiser is always `consultations.doctor_id`, read through the consultation, and the fulfilment time is the `created_at` of the arriving `patient_files` row - neither is a column on the request
- Treating doctor reads the patient's document history from their own consultations with that patient, including files uploaded before the first session
- Prescription and therapy-plan PDF storage and retrieval
- Access-controlled retrieval that cannot be reached by guessing a link
- Patient deletes their own upload, unless it is attached to a completed consultation

Data owned: `patient_files`, `report_requests`. Doctor credentials are NOT here; they are in `doctor_documents` owned by M-05, because the access rule is different.
Depends on: M-01, M-02.
SRS: 4.6, 4.9, 6.1, 6.2.
Done when: a patient can upload history before their first booking, a doctor's report request reaches the patient and is fulfilled against that request, and no file opens for anyone outside that patient's own care.

### M-11 Booking

Purpose: Own the life of an appointment from slot selection to closure, and issue the consultation ID that every clinical and financial record hangs from.

Features:
- Consult Now instant request and Book Appointment scheduled slot
- **Assignment of the provider (SRS 4.20).** The patient picks a service and a time, never a person. This module resolves the pool - specialty, the patient's preferred language as a hard rule, their region under M-06's policy, and M-07's remaining available duration at that moment - and writes the chosen provider onto the consultation
- Refusal when the pool is empty, naming the next time it can be covered, rather than any fallback to a provider who does not match
- What the assignment matched on written to the audit log, so "why this provider" can be answered later
- Admin override that reassigns a consultation to a named provider, with the reason recorded
- Slot held during checkout, released on timeout or failure
- Pre-consult intake answers and documents attached to the booking
- First consultation prompts for medical history; later consultations carry the existing history forward
- Reschedule and cancel within policy, with refund status shown
- Upcoming and past lists for patient and doctor
- No-show marking
- Consultation ID created per consultation

Data owned: `consultations`. Booking and consultation are one row and `consultations.id` is the consultation ID. A row with status `pending_payment` IS the slot hold. The row also carries the follow-up plan and the patient feedback, each written by the module that owns that step. The video session is NOT on the row - it is `consultation_participants`, owned by M-14, because a party can connect more than once.

Assignment adds no column beyond `doctor_id`, which the row already has. What the assignment matched on is an `audit_log` entry: the consultation records WHO, the log records WHY, and why is a record of a decision rather than an attribute of the appointment. This module owns the assignment behaviour; M-06 owns the policy it reads and M-05 owns the pools.
Depends on: M-03, M-04, M-05, M-06, M-07, M-10.
SRS: 4.6, 4.19, 5.2.
Done when: a scheduled booking runs end to end, and an abandoned checkout always releases the slot.

### M-12 Payments and Billing

Purpose: Take payment, show the bill in full, and report what the doctor is owed.

Features:
- Razorpay payment for UPI, cards, netbanking and wallets
- Payment confirmed by gateway webhook, not by the client alone
- Patient bill showing consultation fee, convenience fee, subtotal, GST and final payable
- Doctor payout view showing zero platform deduction and the full consultation fee
- Convenience fee percentage and GST rate configurable from the admin panel
- Refunds raised from the admin panel with status shown to the patient
- Payout reporting, since payouts are made by the client
- Transaction and refund CSV export

Data owned: `payments`, one row per consultation carrying the frozen bill, the refund and the payout. Fee percentage and GST rate are values in `app_config`. There is no gateway events table; replay safety comes from unique gateway payment and refund ids, with raw payloads written to the audit log.
Depends on: M-05, M-11.
SRS: 2.4, 4.7, 4.18.
Done when: the worked example in the SRS reproduces exactly, and a repeated webhook cannot double-charge or double-refund.

### M-13 Presence and Instant Consult

Purpose: Run the Available Now model: doctor status, live requests, and the rule that documentation must be finished before the next instant consult.

Features:
- Seven doctor states: Offline, Available Now, Request Pending, In Consultation, Completing Notes, Paused, Scheduled Only
- Scheduled Only mode that stays bookable but takes no instant requests
- Patient request, doctor acceptance window and timeout
- Decline or timeout re-routes automatically to the next available doctor, chosen by M-11's assignment rules rather than by a routing rule of its own. Language stays a hard requirement on every re-route, so a timeout never lands a patient with a provider who cannot speak to them
- Completion gate blocking a new instant request until prescription or advice and case summary are done
- Live presence and request routing

Data owned: `instant_consultancy`, one row per doctor offered. Doctor presence and the completion-gate flag are columns on the doctor row owned by M-05. An instant request that has not yet found a doctor is a `consultations` row with no doctor set.
Depends on: M-05, M-06, M-07, M-08, M-11.
SRS: 4.10, 4.11, 4.20.
Done when: every state is reachable, a declined request reaches the next doctor without patient action, and the completion gate cannot be bypassed.

### M-14 Video Consultation

Purpose: Put the patient and doctor into the same secure call.

Features:
- A LiveKit room per consultation, named from the consultation ID
- Short-lived join tokens issued by the backend only to the assigned patient and doctor, carrying publish and subscribe rights on that one room
- The LiveKit server URL returned alongside the token, from the environment
- Pre-call device and permission check support
- Mute and camera controls on both sides
- Session metadata stored against the consultation ID, one row per connection, so a mid-consult reconnect is recorded rather than overwriting the first join
- No video or audio recording

Data owned: `consultation_participants`, one row per LiveKit connection, written by the LiveKit webhook. The room is not a row - its name is a function of `consultations.id`. Join tokens are short lived and are not stored; their issue is recorded in the audit log. Call duration, session start and end, and which party failed to show are all read off the participant rows, not stored.
Depends on: M-02, M-03, M-11, M-12.
SRS: 3.3, 4.8, 6.2.
Done when: only the two assigned participants can join, and session metadata is complete after the call.

### M-15 Clinical Records

Purpose: Hold the clinical record of each consultation and enforce that it is completed before the case closes.

Features:
- Structured notes: chief complaint, brief clinical history, diagnosis or provisional diagnosis
- Risk category of low, moderate or high
- In-person or emergency referral, recorded as the note saying what it is for. There is no separate yes/no flag - a written `referral_note` IS the advice
- Medicine prescription, written only where the professional's specialty allows prescribing, with medicine, dose, frequency, duration and instructions
- Advice and therapy plan, written by every professional: what was covered, home practice for the patient, focus for the next session, and warning signs
- Medicine entry is blocked for a professional whose specialty does not allow prescribing; the advice and therapy plan is their closing record
- Both produce the patient PDF through the same record, one per consultation
- Reusable templates for medicines and for advice or therapy plans are deferred to a later release; see SRS section 11
- Report request for the next session, raised here and held by M-10
- Mandatory case summary of three to five lines
- Optional clinical doubt, raised as a `clarification_cases` row against this consultation in M-17. There is no doubt flag on the record - the flag and the case could disagree
- Case completion rule enforced by the system, not by convention
- Consultation ID audit trail across booking, session metadata, prescription and case summary

Data owned: `clinical_records`, one row per consultation. Medicine lines are a list on that row. The case summary, the advice and therapy plan, the referral note and the doctor's Care Hub picks are all columns on it. A clinical doubt is not - it is a `clarification_cases` row in M-17. The row freezes when it is finalised.
Depends on: M-06, M-10, M-11, M-14.
SRS: 4.9, 4.11, 5.2.
Done when: a consultation cannot be marked complete with a missing prescription or advice and summary, a non-prescribing professional cannot save a medicine, and the full record rebuilds from the consultation ID.

### M-16 Follow-Up and Patient Safety

Purpose: Keep care running for seven days after the consult and raise safety alerts in time. This is the platform's core differentiator, so the rules are enforced in the system and stay editable by the admin.

Features:
- Pathway-wise daily check-ins for depression and anxiety, sleep, substance use, bipolar and psychosis, and general follow-up
- Green status: stable or improving, check-ins and care plan continue
- Amber status: worsening, missed medicines, side effects or missed check-in, prompting follow-up booking or doctor review
- Red status: emergency guidance shown at once, and a configurable alert to the doctor and to the admin or care coordinator
- Red-flag detection for self-harm thoughts, severe worsening, confusion or agitation, violence risk, severe withdrawal, medication side effects and feeling unsafe
- Follow-up booking with the same doctor, or the earliest available doctor when review is urgent
- Question sets and red-flag rules authored by the admin and editable with no app release. The treating doctor chooses which pathway a patient gets, from when, for how long, and may add questions for that patient alone. Doctor-added questions never trigger safety alerts.
- Care Plan composition in one place: prescription and warning signs from M-15, the daily check-in from this module, follow-up booking from M-11, recommended self-help from M-18
- Care Plan stores nothing of its own; it reads through each owning module

Data owned: `followup_pathways`, `checkin_responses`, `safety_alerts`. The question set and the red-flag rules are columns on the pathway row, versioned whole. The assignment of a pathway to a patient is columns on the consultation row.
Depends on: M-08, M-11, M-15, and M-18 for the recommended items in the Care Plan.
SRS: 4.13, 4.14, 6.3.
Done when: a red answer produces patient guidance and both alerts, an admin edit to a question set reaches the app with no release, and the Care Plan composes from the owning modules without copying their data.
Note: the Care Plan lands in two steps. Plan, prescription, check-in and follow-up booking ship with this module; recommended self-help appears once M-18 is built.

### M-17 Case Clarification

Purpose: Let a treating doctor get an expert opinion without exposing the patient.

Features:
- Treating doctor posts a de-identified case for senior or expert review
- Name, phone, address, email and other direct identifiers stripped before sharing
- Case fields: title, age and gender, brief history, diagnosis, current plan, the specific doubt, urgency, attachments
- Expert sees only queries shared with them and nothing else
- Expert responds with comments, clinical considerations, a request for clarification, or advice to bring follow-up forward
- Status tracking: Draft, Posted, Awaiting Response, Response Received, Clarification Asked, Reviewed, Closed
- Nothing reaches the patient automatically; the treating doctor owns all patient communication

Data owned: `clarification_cases`, one row per case carrying the de-identified snapshot, the single expert assignment and the discussion thread. Attachments are `patient_files` rows with a `clarification_case_id`, owned by M-10; a schema CHECK makes such a row carry no `patient_id`, so de-identification is structural.
Depends on: M-02, M-05, M-10, M-15.
SRS: 4.12, 6.2, 8.
Done when: an expert account sees only its assigned cases, and no shared case holds a direct identifier.

### M-18 Care Hub

Purpose: Hold the education and self-help library, and the mechanism by which a doctor recommends items from it.

Features:
- Self-help tools: breathing, grounding, sleep hygiene, activity scheduling, craving diary, medication adherence
- Condition-wise patient education library
- Clinician-reviewed blogs and articles
- Caregiver and family guide, shareable with the patient's consent
- NGO and support directory with contact, location, timings and verification status
- Persistent emergency guidance
- Doctor selects items after a consult; the patient sees them marked as recommended by their doctor
- Recommendations recorded against a consultation ID, with no clinical data held here
- Admin authoring, clinical review status and publishing with no app release
- No peer groups and no open discussion forums

Data owned: `content_items`, one table for self-help tools, education modules, blogs, caregiver guides, emergency guidance, the NGO directory and specialty red-flag references, separated by kind. Doctor recommendations are a list on the clinical record.
Depends on: M-02, M-06.
SRS: 2.4, 4.15.
Done when: all content is admin-published without a release, and a doctor's selected items reach the patient through the Care Plan.

### M-19 Feedback and Complaints

Purpose: Collect what patients think and resolve what goes wrong.

Features:
- Post-consult feedback from the patient
- Complaint raising with the related consultation
- Complaint workflow and resolution tracking
- Admin review of feedback and complaints

Data owned: `complaints`, with the message thread on the row. Post-consult feedback is columns on the consultation row.
Depends on: M-02, M-11.
SRS: 4.17, 4.18.
Done when: a complaint can be raised, tracked and closed with its full history kept.

### M-20 Governance and Quality

Purpose: Give the admin the operational and clinical control room.

Features:
- Pending case summaries, high-risk alerts and follow-up alerts as working queues
- Case clarification tracker
- Appointment oversight: scheduled and instant consults, cancellations, no-shows, rescheduling
- Quality dashboard: completed cases, pending summaries, red flags, follow-up alerts, complaints
- Doctor reliability metrics: acceptance rate, no-show rate, case summary completion
- **Allocation oversight (SRS 18.9):** who is assignable for a given service, language, region and time, with the duration each has still free; which consultations were assigned to whom and on what basis; where region had to be relaxed; and where a pool came up empty
- CSV export

Data owned: nothing. Every queue and metric is read from the table that owns it, so a dashboard figure can never disagree with its source. The allocation views read M-05's pools, M-06's policy, M-07's availability and M-21's audit entries; the override itself is M-11's, exposed here.
Depends on: M-11 to M-19.
SRS: 4.18, 6.7, 4.20.
Done when: every number on the dashboard reconciles with the owning module's data.

### M-21 Audit, Compliance and Data Rights

Purpose: Prove who saw and changed what, and honour data requests.

Features:
- Audit entries for clinical record access, financial changes and configuration changes
- Log search by actor, module and date, with export
- Retention rules set by the client
- Execution of the data deletion requests raised in M-03
- Log visibility limited by admin permission level

Data owned: nothing of its own. `audit_log` is created by M-01 because every module writes to it from its first release. Retention rules are a value in `app_config`. Deletion execution evidence is columns on the request row owned by M-03. This module owns the search, retention and data-rights behaviour over them.
Depends on: M-01, and every module writing audit entries.
SRS: 5.2, 5.3, 6.1, 6.7, 8.
Done when: a clinical record read, a refund and a configuration change each leave a complete entry with actor, target and time.

---

## 6. Build Order

- M-01 to M-04: foundation, identity, consent, patient profile. Nothing patient-facing works before these.
- M-05 to M-07: providers, the catalogue they are matched against, and their bookable time. Supply exists before demand. Version 1.3 note: M-06 now carries the allocation policy and the region catalogue, and M-05's region pools point at it, so the two are closer coupled than the order suggests - build M-06's `regions` before M-05's `doctor_regions`.
- M-08 to M-10: notifications, search, documents. Used by everything after them.
- M-11 and M-12: booking and payment. First end-to-end value, matching Demo 1 in the proposal.
- M-13 to M-15: instant consults, video, clinical records with the completion gate.
- M-16: seven-day follow-up, safety alerts and the Care Plan composition, matching Demo 2 in the proposal.
- M-17 and M-18: case clarification and the Care Hub library. Care Hub completes the recommended self-help part of the Care Plan.
- M-19 and M-20: feedback and the admin control room, matching Demo 3 in the proposal.
- M-21: audit, retention and data rights.

---

## 7. Cross-Module Rules

- One module owns each piece of data. Others read it through that module's public interface, never from its tables.
- Screens that only bring other modules together, the patient home and the Care Plan, own no data and read through the owning modules.
- Modules talk by a direct call to a published interface or by an event.
- Safety overrides flow: a crisis query in M-09 and a red status in M-16 interrupt whatever is in progress.
- Configuration lives with its owning module and is edited from the admin panel: mapping and crisis keywords in M-09, pathways and red-flag rules in M-16, specialties, regions, forms and the allocation policy in M-06, fee and GST in M-12.
- Assignment is decided in one place. M-11 resolves the provider for every consultation, scheduled or instant, and M-13 re-routes by calling it rather than by holding a rule of its own. Two implementations of "who takes this patient" would drift, and the one that drifted would be the one that put a patient with a provider who could not speak to them.
- Every module touching clinical or financial data writes audit entries from its first release, not later.
- No module stores a value it can calculate from data another module already holds. The two exceptions are the billed amounts, frozen at checkout so a later fee change cannot rewrite a past invoice, and the completion-gate flag on the doctor record, read on every instant routing decision.
- A module that composes other modules owns no tables. That is true of the patient home, the Care Plan and the whole of M-20.
- All clinical content and clinical rules are authored and approved by the client before launch; modules provide the tools, not the wording.

---

## 8. Revision History

### Version 1.3, 1 September 2026

Client instructions of 1 September 2026, carried into the module plan from SRS
version 1.2. The twenty one modules, their names and their build order are
unchanged. What changed is what M-06 owns, and where the decision "who takes
this patient" is made.

**M-06 widened, and renamed**

- Now "Catalogue, Specialty and Allocation Configuration". It gains `regions` as a third owned table, the registration form on the specialty row, a specialty-wise fee pending SRS FR-7.8, and the allocation policy as an `app_config` value.
- It is the catalogue assignment matches against, so the matching rules live beside the things they match on rather than beside the code that runs them.

**Assignment is M-11's, in one place**

- M-11 resolves the provider for every consultation from specialty, language, region and remaining available duration, and writes it onto the row it already owns. No new column: `consultations.doctor_id` is the answer, and the audit log is the reason.
- M-13 re-routes a declined or timed-out instant request by calling the same resolution, not by holding its own rule. Language stays a hard requirement on every re-route.
- M-20 exposes the oversight and the override; M-05 owns the pools; M-06 owns the policy. Four modules touch allocation and each owns exactly one part of it.

**M-05 loses the patient-facing directory**

- The browsable, filterable, sortable provider list built for M-05 contradicts SRS 4.2 as it now reads. The roster stays, admin-only; the patient's view of a provider becomes the profile of the one assigned to them.
- This is a removal of working code, not a deferral. It is the cost of the change and it is small, which is the argument for making the change now rather than after M-11.

**Two registration forms**

- Section 3 replaces the Doctor user type with Provider on two forms, doctor and non-doctor healthcare provider.
- The form sits on the specialty, not on the provider record. The specialty already decides prescribing eligibility and the required credential list, and a copy on the provider could disagree with it. This also means M-05 needs no new column and no new branch: it already asks the specialty what to demand.
- Both forms are the same account in the same `doctors` table. The naming is left open in SRS 14.

**Regions are new to the product**

- Region appears nowhere in version 1.2, in `db/schema.dbml`, or in the built code. It needs `regions` (M-06), `doctor_regions` (M-05) and `patients.region_id` (M-04, on M-02's row).
- M-04's dependency list gains M-06 for the region list, and its data line gains the column. It still owns no table.

**Four decisions taken the same day** (SRS 14)

1. The consultation fee is per specialty. `doctors.consultation_fee_inr` becomes the provider payout figure rather than the patient price.
2. Region is a relaxable preference; assignment records when it relaxed one. Language is never relaxed.
3. A region is a state or province, held as rows so the granularity can change without a release.
4. A patient may decline an assigned provider a configured number of times, with the reason recorded.

Only the naming of "doctor" is still open, and it blocks no data model work.

**Unchanged and re-confirmed**

- Every table still has exactly one owning module. `doctor_regions` belongs to M-05 for the same reason `doctors.specialty_id` does: it is an attribute of a provider, while the catalogue it points at belongs to M-06.
- M-09's output changes from a ranked list of people to a service and a concern, but it still owns no data.
- Consent, audit, privacy and the expert-opinion visibility rules are untouched.

### Version 1.2, 31 August 2026

LiveKit integration, and the data-ownership audit it triggered. The twenty one
modules, their order and their completion criteria are unchanged.

**M-14 now owns a table**

- `consultation_participants`, one row per LiveKit connection, written by the LiveKit webhook. It replaced `patient_joined_at`, `patient_left_at`, `doctor_joined_at` and `doctor_left_at` on the consultation row: LiveKit fires join and leave per **connection**, and a phone that drops signal mid-consult produces several of each, which four timestamps cannot hold.
- The room is still not a row - its name is a function of `consultations.id`. The join token is still not a row - it lives for minutes, and its issue is an `audit_log` entry.
- Call duration, session start and end, and which party failed to show are read off the participant rows. None is stored.
- This corrects the version 1.1 statements that the video session lives on the consultation row and that M-14 owns no tables. M-09, M-20 and M-21 still own none.

**Corrections to version 1.1 data lines, found by re-reading the schema**

- M-02, M-08: admins have no `push_token` and no `device_id`. SRS 2.3 puts the panel in a desktop browser, so admin alerts are `notifications` rows read in-panel, never pushed. Version 1.1 said all three account rows carry push state.
- M-05: registration certificate expiry is not tracked. No FR asks for it and `doctor_documents` has no `expires_on`; confirming a registration is current is the client's obligation under SRS section 8. The version 1.1 feature bullet described a column that does not exist.
- M-05: a doctor has one specialty, not several. `specialty_ids` became `specialty_id`, and it is what decides prescribing eligibility.
- M-10: `report_requests` carries neither the raising doctor nor a fulfilment date. The raiser is always `consultations.doctor_id`; fulfilment is the `created_at` of the arriving `patient_files` row.
- M-15: there is no `referral_advised` flag and no `has_clinical_doubt` flag. A written `referral_note` IS the referral advice, and a doubt IS a `clarification_cases` row - a flag beside either could disagree with it.
- M-06: specialty red-flag references are `content_items` rows owned by M-18, not columns on the specialty row. Neither `specialties` nor `concerns` is versioned; the change history is the audit log.
- M-17: added M-10 to its dependencies. Case attachments are `patient_files` rows carrying a `clarification_case_id`, and the CHECK that forbids a `patient_id` on such a row is what makes de-identification structural.

**Unchanged and re-confirmed against the schema**

- Every one of the twenty six tables has exactly one owning module, and no table is claimed twice.
- M-04, M-09, M-20 and M-21 own no tables. M-12's replay safety is the unique `gateway_payment_id` and `gateway_refund_id`, with no gateway events table. M-07 generates no slots. M-16's five alert types match FR-9.8 exactly.


### Version 1.1, 27 August 2026

The twenty one modules, their order and their completion criteria are unchanged.
What changed is the user model and the statement of what each module owns.

**User types, section 3**

- Three account kinds, each in its own table: patient, doctor, admin.
- Expert doctor became a level on the doctor record. Care coordinator became an admin permission level. Service account was removed in favour of HMAC signature verification on the payment webhook.
- Doctor registration is now stated as a five step flow with per-credential admin approval.

**Data owned, all twenty one modules**

Every module's data line now names the real tables. Version 1.0 listed intended
entities; several of those turned out to be one row on a record that already
existed rather than a table of their own. The notable ones:

- M-11 owns one `consultations` table. Booking, the slot hold, the video session, the follow-up plan and the patient feedback are all on that row. M-13, M-14 and M-16 write to it rather than holding their own copies.
- M-12 owns one `payments` table carrying the bill, the refund and the payout. There is no gateway events table; replay safety comes from unique gateway ids.
- M-07 owns one availability table and generates no slots.
- M-09, M-14, M-20 and M-21 own no tables at all. They are behaviour over data other modules hold.
- M-05 owns doctor credentials in `doctor_documents`, kept apart from patient files because the access rule differs.

**Scope**

- Prescription and therapy-plan templates deferred from M-06 and M-15.
- Server-side search query logging removed from M-09; recent searches move to the device.
- Doctor reliability metrics are counted on demand, not stored as counters on the doctor record.

**Added**

- The treating doctor may add patient-specific check-in questions on top of the assigned pathway, held on the consultation row. See SRS FR-13.8.

**Identity provider**

- Slide owns OTP issue, expiry and attempt state. M-02 stores only the successful verification fact and enforces the platform's own rate limit from the audit log. See SRS sections 3.3 and FR-1.9.

**Renamed**

- M-13 owns `instant_consultancy`, called `instant_offers` in the first draft.

**Still open**

- Client confirmation that patient and doctor ship as two store listings. This plan is written on that basis; SRS section 2.4 carries the same note. Needed before Week 3.
