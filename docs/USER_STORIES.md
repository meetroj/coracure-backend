# User Stories

## Doctor Consultation Platform — Patient App and Doctor App

Version 1.0
Date: 9 September 2026
Prepared by: Synquic
Source documents: `docs/SRS 1.md` version 1.2, `docs/MODULES 1.md` version 1.3,
`db/schema.dbml`, and the shipped backend controllers under `src/`.

This document turns the twenty one backend modules into user stories for the two
mobile apps. The admin web panel is out of scope here and is covered by the
module plan; where an admin action is the precondition of a patient or doctor
story it is named as a precondition, not written as a story.

---

## 1. How to Read This

- Stories are grouped by **app first, module second**, because a team builds one app at a time and a module often touches both apps with different stories.
- Story IDs are `PT-<module>-<n>` for the patient app and `DR-<module>-<n>` for the doctor app. The module number matches the module plan, so `PT-11-03` is the third patient story of M-11 Booking.
- Every story carries acceptance criteria and the endpoints it consumes. Paths are shown from the version segment; the deployed path is `<API_PREFIX>/v1/...`.
- A story is **done** when the screen works, the endpoint is connected, role and ownership errors render as readable states, loading and empty states exist, and the flow is covered by at least one test.

### Conventions used in the criteria

- **The patient never picks a provider.** The patient picks a service and a time; the backend assigns the provider (M-11). No screen may offer a browsable doctor list.
- **Language is never relaxed.** Region may be relaxed by policy; the patient's preferred language is a hard rule on first assignment and on every re-route.
- **No diagnosis in a notification.** Push and in-app copy names the event, never the clinical content.
- **Nothing is a slot until payment.** A `pending_payment` consultation is the hold, and it expires.

---

# Part A — Patient App

## M-02 Identity and Access

### PT-02-01 Sign up and sign in with a mobile OTP

As a patient, I want to sign in with my mobile number and a one-time code, so
that I never have to remember a password.

- Entering a valid mobile number requests an OTP and moves to the code screen with a resend timer.
- A correct code signs me in and returns me to where I was; a wrong code shows attempts remaining without revealing whether the number is registered.
- A first-time number creates the account and routes me into profile completion; a returning number lands on home.
- Rate-limit refusals render as a plain "try again in N minutes" state, not a raw error.
- `POST /v1/auth/patient/otp/request`, `POST /v1/auth/patient/otp/verify`

### PT-02-02 Be refused politely when I use the wrong app

As a patient, I want a clear message if I try my number in the doctor app, so
that I install the right one instead of thinking the platform is broken.

- A doctor or admin identity signing in through the patient app is refused with a plain message naming the correct app.
- The refusal never states whether that account exists.

### PT-02-03 Stay signed in, and sign out everywhere

As a patient, I want my session to persist across app restarts and to end when I
sign out, so that my records are safe on a shared phone.

- Access token refresh is transparent; a failed refresh returns me to sign-in without losing unsaved form input.
- Sign-out clears local credentials, deregisters the push device, and invalidates the session server-side.
- `POST /v1/auth/refresh`, `POST /v1/auth/sign-out`

## M-03 Consent and Legal

### PT-03-01 Give teleconsultation consent before my first consultation

As a patient, I want to read and accept the teleconsultation consent, so that I
know what I am agreeing to before a doctor sees me.

- Consent is requested once, before the first consultation can start, and the recorded version and timestamp are visible to me afterwards.
- Declining leaves me able to browse but blocks booking, with an explanation of what consent is for.
- A new consent version re-prompts on the next booking rather than silently proceeding.
- `GET /v1/legal/consents/me/status`, `POST /v1/legal/consents`, `GET /v1/legal/consents/me`

### PT-03-02 Read the policies inside the app

As a patient, I want the privacy policy, terms, refund and reconsult policy in
the app, so that I do not have to hunt for them on a website.

- Each document renders from the backend with its version and effective date; no policy text is hardcoded in the app.
- The refund policy is reachable from the cancellation and refund screens, at the moment it matters.
- `GET /v1/legal/documents`, `GET /v1/legal/documents/:documentType`

### PT-03-03 Ask for my data to be deleted

As a patient, I want to request deletion of my data and see what happened to the
request, so that I stay in control of my records.

- The request screen states plainly what is deleted and what is retained for legal reasons.
- The request shows a status, and the outcome once an admin has acted.
- `POST /v1/me/deletion-requests`, `GET /v1/me/deletion-requests`

## M-04 Patient Profile

### PT-04-01 Complete my profile

As a patient, I want to enter my name, age, gender, contact, language and
region, so that I am matched with a professional who can actually speak to me.

- Preferred language and region are required, and the field copy says why: they decide who is assigned.
- Values come from the backend catalogue, never a hardcoded list.
- The profile is editable later, and a language or region change affects the next assignment, not past ones.
- `GET /v1/me/profile`, `PATCH /v1/me/profile`

### PT-04-02 Keep my own records private

As a patient, I want to be sure nobody but my treating professionals can read my
profile, so that I trust the app with sensitive detail.

- Every profile read is scoped to me; an ownership failure renders as a not-found state rather than an authorisation hint.

## M-09 Search and Concern Mapping

### PT-09-01 Describe my problem in my own words

As a patient, I want to type or speak what I am feeling, in English, Hindi or a
mix, so that I do not have to know which specialist I need.

- Free text returns ranked services and concerns, each with a plain-language reason.
- Results show the fee for the service and the soonest time the pool can cover it, never a named provider with their own diary.
- The screen states, visibly, that this does not screen, diagnose or decide treatment.
- `POST /v1/search`

### PT-09-02 Be shown emergency guidance when I am in crisis

As a patient in crisis, I want emergency guidance immediately rather than search
results, so that I get help now.

- A crisis phrase interrupts the flow and replaces results with emergency guidance and contacts.
- The guidance is dismissed only by an explicit action, and booking remains reachable afterwards.
- Guidance copy comes from configuration and changes with no app release.

### PT-09-03 Browse when I am unsure

As a patient who cannot name the problem, I want a guide and suggestions, so
that I can start without describing symptoms.

- The concern guide is optional and never forced before booking.
- Popular searches and suggestions come from configuration; my recent searches stay on my device and are clearable.
- `GET /v1/search/guide`, `GET /v1/search/suggestions`

## M-06 and M-07 Catalogue and Slots (patient-facing reads)

### PT-06-01 See the services on offer with their price

As a patient, I want to see the available services and what each costs before I
commit, so that there is no surprise at checkout.

- The service list, its fee and its concerns are read from the catalogue; disabled entries never appear.
- `GET /v1/services`, `GET /v1/concerns`, `GET /v1/regions`. The specialty catalogue itself is admin-only (`/v1/admin/specialties`); the patient app reads services.

### PT-07-01 Pick a time, not a person

As a patient, I want to choose a date and time for the service, so that I can
fit the consultation around my day.

- The picker shows times the pool can cover for the full consultation duration, not merely times somebody starts free.
- A time that is no longer coverable is refused at booking with `NO_PROVIDER_AVAILABLE` and the soonest time the pool can cover, and the picker updates rather than failing silently.
- `POST /v1/search` carries the soonest coverable time per service; `POST /v1/me/consultations` is the authority. See gap G-1: there is no patient-facing slot lookup yet.

## M-11 Booking

### PT-11-01 Book a scheduled consultation

As a patient, I want to book a consultation for a chosen service and time, so
that I have an appointment I can plan around.

- Booking creates a `pending_payment` consultation that holds the time, and the hold shows a countdown.
- Abandoning checkout releases the hold, and the time reappears for others.
- On payment the assigned professional's profile becomes visible to me, with their qualification, experience and languages.
- `POST /v1/me/consultations`

### PT-11-02 Be told when nobody can cover my request

As a patient, I want a straight answer when no professional matches me, so that
I can pick another time instead of waiting on a silent screen.

- An empty pool returns a refusal naming the next time the service can be covered.
- The app never falls back to a professional who does not speak my language.

### PT-11-03 Complete the pre-consult intake

As a patient, I want to answer the intake questions and attach my history before
the consultation, so that the session is not spent on paperwork.

- The first consultation prompts for medical history; later consultations carry the existing history forward and ask only what changed.
- The intake form is specialty-specific and rendered from the backend.
- Answers and attachments are saved against the consultation and are visible to the assigned professional.

### PT-11-04 Decline an assigned professional

As a patient, I want a limited right to decline the professional I was given, so
that I have a say without breaking the queue.

- The decline screen states how many declines remain and asks for a reason.
- After the last permitted decline the option disappears, with an explanation.
- Declining re-runs assignment and shows the new professional, or an empty-pool refusal.
- `POST /v1/me/consultations/:consultationId/decline-provider`

### PT-11-05 Reschedule or cancel within policy

As a patient, I want to move or cancel my appointment and see the refund
consequence before I confirm, so that I am not surprised by a charge.

- The confirm dialog states the refund outcome under the current policy before the action is taken.
- A rescheduled consultation keeps its consultation ID and its clinical history.
- `POST /v1/me/consultations/:consultationId/reschedule`, `POST /v1/me/consultations/:consultationId/cancel`

### PT-11-06 See my upcoming and past consultations

As a patient, I want one place listing what is coming and what has happened, so
that I can find a past prescription or join today's call.

- Upcoming items show the time, the service, the assigned professional and the join action when the call is open.
- Past items link to the clinical record, the prescription or plan, the bill, and the feedback action.
- `GET /v1/me/consultations`, `GET /v1/me/consultations/:consultationId`

## M-12 Payments and Billing

### PT-12-01 Pay for a consultation

As a patient, I want to pay by UPI, card, netbanking or wallet, so that I can
use whatever I already have.

- Checkout opens the gateway; success is confirmed by the backend, never by the client alone.
- A closed or failed payment returns me to a retry state with the hold still counting down, and a lapsed hold is explained plainly.
- `POST /v1/me/consultations/:consultationId/checkout`

### PT-12-02 See the bill in full

As a patient, I want the consultation fee, convenience fee, GST and total broken
out, so that I can see exactly what I paid for.

- Every line of the frozen bill is shown, and the total matches the amount charged.
- A later change to fees or GST never rewrites a past bill.
- `GET /v1/me/consultations/:consultationId/bill`

### PT-12-03 Track a refund

As a patient, I want to see the status of a refund after a cancellation, so that
I know whether to chase it.

- Refund status is visible on the consultation and on the bill, with the amount and the stage it has reached.

## M-13 Instant Consult

### PT-13-01 Consult now

As a patient, I want to request a consultation immediately, so that I can be
seen when I cannot wait for a slot.

- The request screen shows the service, its fee and a live waiting state.
- A decline or timeout re-routes to the next professional without any action from me, and the screen says so rather than looking stalled.
- Every re-route still respects my language.
- The request can be cancelled, and cancelling releases any hold and follows the refund path cleanly.
- `POST /v1/me/consultations/instant`, `GET /v1/me/consultations/:consultationId/instant-status`

## M-14 Video Consultation

### PT-14-01 Check my camera and microphone before joining

As a patient, I want to test my device and permissions before the call, so that
I do not waste consultation time on setup.

- The pre-call screen requests permissions, previews camera and microphone, and reports readiness.
- A missing permission gives OS-specific guidance to fix it.
- `GET /v1/consultations/:consultationId/video/readiness`

### PT-14-02 Join the consultation

As a patient, I want to join my consultation securely, so that only my
professional and I are in the room.

- Joining fetches a short-lived token for that one consultation; the token is never persisted.
- Only the assigned patient and professional can join; anyone else is refused.
- Mute and camera controls work on my side, a dropped connection reconnects into the same room, and the reconnect is recorded rather than replacing the first join.
- The screen states that the call is not recorded.
- `POST /v1/consultations/:consultationId/video/token`, `GET /v1/consultations/:consultationId/video/session`

## M-10 Documents and Files

### PT-10-01 Upload my medical history before my first booking

As a patient, I want to add my history and old reports before I book, so that
the first session starts with context.

- History is held against me, not one booking, and is carried into every later consultation.
- Uploads use a pre-signed URL and show progress, retry and failure states.
- `POST /v1/me/files/upload-url`, `GET /v1/me/files`

### PT-10-02 Respond to a report request from my doctor

As a patient, I want to see what my doctor asked for and upload against that
request, so that my file arrives labelled and is not missed.

- Open requests appear on the consultation and in my file list, naming what is needed and why.
- Uploading against a request marks it fulfilled without any further step.
- `GET /v1/me/files/requests/open`

### PT-10-03 Retrieve and remove my files

As a patient, I want to open my own files and delete ones I added by mistake, so
that my record stays accurate.

- Files open through an access-controlled link that cannot be reached by guessing.
- A file attached to a completed consultation cannot be deleted, and the reason is stated.
- `GET /v1/me/files/:fileId/download-url`, `DELETE /v1/me/files/:fileId`

## M-15 Clinical Records (patient view)

### PT-15-01 Read what my doctor wrote

As a patient, I want my prescription or my advice and therapy plan after the
consultation, so that I can follow it at home.

- A prescribing professional's record shows the medicines with dose, frequency, duration and instructions.
- A non-prescribing professional's record shows the advice and therapy plan: what was covered, home practice, next-session focus and warning signs.
- The record is available only once the professional has finalised it, and shows a plain "being written up" state before that.
- The PDF is downloadable and shareable from the app.
- `GET /v1/me/consultations/:consultationId/care-record`

### PT-15-02 See a referral when one is advised

As a patient, I want in-person or emergency referral advice shown clearly, so
that I act on it.

- Referral advice renders as its own prominent block on the record, not buried in the notes.

## M-16 Follow-Up and Patient Safety

### PT-16-01 Do my daily check-in

As a patient, I want a short daily check-in for the seven days after my
consultation, so that my care does not stop when the call ends.

- The check-in question set is the pathway my professional assigned, rendered from the backend and changeable with no app release.
- Answering shows a green, amber or red outcome in plain language, never a diagnosis.
- A missed check-in is reflected the next day rather than silently skipped.
- `GET /v1/me/consultations/:consultationId/checkin`, `POST /v1/me/consultations/:consultationId/checkin`, `GET /v1/me/consultations/:consultationId/checkins`

### PT-16-02 Get help immediately when an answer is red

As a patient reporting something serious, I want emergency guidance at once, so
that I am not left alone with it.

- A red answer shows emergency guidance immediately, ahead of everything else in progress.
- The same event alerts my professional and the care coordinator, and I am told that it has.

### PT-16-03 Act on an amber outcome

As a patient whose answers are worsening, I want a clear next step, so that I
know whether to book again.

- An amber outcome offers a follow-up booking or a review request in one tap.
- Follow-up booking prefers the same professional, and offers the earliest available one when review is urgent.

### PT-16-04 See my care plan in one place

As a patient, I want my prescription, warning signs, check-in, follow-up and
recommended self-help on one screen, so that I do not have to hunt for my own
treatment.

- The care plan composes from the owning modules and shows nothing it holds itself.
- Items recommended by my professional are marked as such.
- `GET /v1/me/consultations/:consultationId/care-plan`

## M-18 Care Hub

### PT-18-01 Use self-help tools

As a patient, I want breathing, grounding, sleep hygiene and other tools in the
app, so that I have something to do between sessions.

- Tools and education content are published by the platform and appear with no app release.
- Content recommended by my professional for me is shown first and labelled as their recommendation.
- `GET /v1/care-hub/items`, `GET /v1/care-hub/items/:slug`

### PT-18-02 Reach emergency guidance from anywhere

As a patient, I want emergency guidance always within reach, so that I never
have to search for it in a bad moment.

- A persistent entry point exists on the main patient screens and works outside a consultation.
- `GET /v1/care-hub/emergency`

## M-19 Feedback and Complaints

### PT-19-01 Give feedback after a consultation

As a patient, I want to rate and comment on the consultation, so that quality is
watched.

- Feedback is requested once after completion and is skippable.
- Submitted feedback is editable until a configured cut-off, and is never shown publicly with my name.
- `PUT /v1/me/consultations/:consultationId/feedback`, `GET /v1/me/consultations/:consultationId/feedback`

### PT-19-02 Raise and follow a complaint

As a patient, I want to raise a complaint about a consultation and see its
progress, so that I know it is being handled.

- A complaint attaches to the related consultation and carries its full message thread.
- I can reply, and I see status changes through to closure.
- `POST /v1/me/complaints`, `GET /v1/me/complaints/:complaintId`, `POST /v1/me/complaints/:complaintId/reply`

## M-08 Notifications (patient)

### PT-08-01 Be reminded about my care

As a patient, I want push and in-app notifications for the things that matter,
so that I do not miss my consultation or my check-in.

- Booking confirmed, consult reminder, doctor joined, prescription ready, check-in due and report requested each arrive and deep-link to the right screen.
- No notification names a diagnosis or clinical content.
- Copy comes from the backend and changes without an app release.
- Push registration and permission refusal are both handled; in-app notifications still work without push permission.
- `GET /v1/me/notifications`, `GET /v1/me/notifications/unread-count`, `POST /v1/me/notifications/:notificationId/read`, `POST /v1/me/notifications/read-all`

## M-21 Data Rights (patient)

### PT-21-01 Export my own data

As a patient, I want a copy of my data, so that I can keep or move my records.

- The export includes my profile, consultations, records, files and payments, and is delivered through an access-controlled link.
- `GET /v1/me/data-export`

---

# Part B — Doctor App

Throughout this part, "provider" and "doctor" mean the same account. A
non-doctor healthcare provider signs in here identically; what differs is the
registration form their specialty declares and whether that specialty may
prescribe.

## M-02 Identity and Access

### DR-02-01 Sign in with a mobile OTP

As a provider, I want to sign in with my number and a one-time code, so that I
can start work without another password.

- Only an account that already exists in the doctor registry can sign in; there is no self sign-up path anywhere in the app.
- A patient or admin identity is refused with a plain message naming the correct app.
- `POST /v1/auth/doctor/otp/request`, `POST /v1/auth/doctor/otp/verify`

### DR-02-02 Be blocked from clinical work until I am verified

As an unverified provider, I want to see exactly what is outstanding, so that I
can finish onboarding instead of guessing.

- An unverified account reaches only the profile and credential screens; consult surfaces are visibly locked with the reason.
- The lock lifts without a release once an admin verifies and lists the account.

## M-05 Registry and Verification

### DR-05-01 Complete my profile

As a provider, I want to fill in my qualification, registration number,
experience, languages, consultation duration and buffer, so that I am bookable
and matched correctly.

- The form shown is the one my specialty declares — doctor or non-doctor healthcare provider — and the medical council registration field appears only where that form requires it.
- Languages drive assignment, and the field copy says so.
- `GET /v1/me/doctor/profile`, `PATCH /v1/me/doctor/profile`

### DR-05-02 Upload my credentials

As a provider, I want to upload each document my specialty requires and see its
review state, so that I know what is holding up my verification.

- The required document list comes from my specialty, not from a hardcoded list in the app.
- Each document shows pending, approved or rejected; a rejection shows the admin's reason and allows re-upload.
- Verification completes only when every required document is approved, and the app reflects that without a re-install.
- `GET /v1/me/doctor/credentials`, `POST /v1/me/doctor/credentials/upload-url`, `POST /v1/me/doctor/credentials`

### DR-05-03 See my own reliability metrics

As a provider, I want my acceptance rate, no-show rate and case-summary
completion, so that I can see how I am doing before an admin raises it.

- Figures are counted from consultations at read time and always reconcile with my own lists.
- `GET /v1/doctors/:doctorId/reliability`

## M-07 Availability and Scheduling

### DR-07-01 Set my weekly availability

As a provider, I want to set the hours I work each week, so that I am only
booked when I am actually free.

- The weekly pattern saves as a whole and takes effect for future bookings only.
- Consultation duration and buffer are respected when times are offered to patients.
- `GET /v1/me/doctor/availability`, `PUT /v1/me/doctor/availability/weekly`

### DR-07-02 Block dates and take leave

As a provider, I want to block a date or a range, so that I am not booked while
I am away.

- A blocked date never appears as bookable to any patient.
- A block that collides with an existing booking is refused, naming the booking, rather than silently orphaning a patient.
- `POST /v1/me/doctor/availability/blocked`, `POST /v1/me/doctor/availability/custom-hours`, `DELETE /v1/me/doctor/availability/:ruleId`

### DR-07-03 See how much free time I actually have

As a provider, I want to see the duration I have free from now, so that I
understand why I am or am not receiving assignments.

- The screen answers "free for how long from this moment", not merely "free now".
- `GET /v1/admin/availability/remaining` exists today but is admin-scoped. See gap G-2.

## M-13 Presence and Instant Consult

### DR-13-01 Set my working state

As a provider, I want to move between Offline, Available Now, Paused and
Scheduled Only, so that the platform sends me work only when I can take it.

- All seven states are reachable and their meaning is stated on the screen: Offline, Available Now, Request Pending, In Consultation, Completing Notes, Paused, Scheduled Only.
- Scheduled Only stays bookable for appointments but takes no instant requests.
- Request Pending, In Consultation and Completing Notes are set by the system; the app shows them without letting me fake them.
- `GET /v1/me/doctor/presence`, `PUT /v1/me/doctor/presence`

### DR-13-02 Receive and answer an instant request

As a provider, I want an instant request with a visible acceptance window, so
that I can take it or let it pass without leaving a patient waiting.

- An incoming request shows the service, the patient's language and a countdown.
- Accepting takes me into the consultation; declining or timing out re-routes to the next provider with no further action from me.
- `GET /v1/me/doctor/instant-requests`, `POST /v1/me/doctor/instant-requests/:consultationId/accept`, `POST /v1/me/doctor/instant-requests/:consultationId/decline`

### DR-13-03 Be stopped from taking a new instant consult with documentation open

As a provider, I want the app to hold back new instant requests until my last
case is written up, so that documentation never falls behind care.

- With an unfinished prescription or advice and case summary, Available Now is refused and the outstanding case is named, with a direct link to it.
- The gate cannot be bypassed by restarting the app or toggling presence.
- `GET /v1/doctor/pending-documentation`

## M-11 Booking (provider view)

### DR-11-01 See my schedule

As a provider, I want my upcoming and past consultations in one list, so that I
can prepare and find old cases.

- Upcoming items show the time, the service, the patient's first name and language, and the join action when the call is open.
- Past items link to the clinical record and the case summary state.
- `GET /v1/doctor/consultations`, `GET /v1/doctor/consultations/:consultationId`

### DR-11-02 Read the intake before the call

As a provider, I want the patient's intake answers, history and uploads before I
join, so that I do not spend the session collecting facts.

- The consultation detail shows intake answers, the medical history and every file attached to the case.
- A first consultation is marked as such, so I know no prior history exists.

### DR-11-03 Mark a no-show

As a provider, I want to mark a patient no-show, so that the case closes
correctly and my reliability figures stay accurate.

- No-show is available only after the scheduled start and the configured wait.
- Marking it closes the case without demanding a clinical record.
- `POST /v1/doctor/consultations/:consultationId/no-show`, `POST /v1/doctor/consultations/:consultationId/cancel`

## M-14 Video Consultation

### DR-14-01 Check my setup and join

As a provider, I want a device check and a secure join, so that the consultation
starts on time and stays private.

- Pre-call readiness reports camera, microphone and permission state before I enter.
- Only I and my assigned patient can join; the token is short-lived and scoped to the one consultation.
- Mute and camera controls work, a reconnect returns me to the same room, and the app states that nothing is recorded.
- The room shows whether the patient has joined yet, and reflects a mid-call drop rather than showing them as present.
- `GET /v1/consultations/:consultationId/video/readiness`, `POST /v1/consultations/:consultationId/video/token`, `GET /v1/consultations/:consultationId/video/session`

## M-15 Clinical Records

### DR-15-01 Write structured notes

As a provider, I want chief complaint, brief history and diagnosis fields, so
that the record is consistent across every case.

- Notes save as a draft repeatedly during and after the call without finalising.
- A risk category of low, moderate or high is required.
- `PUT /v1/doctor/consultations/:consultationId/clinical-record`, `GET /v1/doctor/consultations/:consultationId/clinical-record`

### DR-15-02 Write a prescription, where my specialty allows it

As a prescribing provider, I want to record medicines with dose, frequency,
duration and instructions, so that the patient gets a usable prescription.

- The medicine section appears only when my specialty permits prescribing.
- A non-prescribing provider never sees the section, and a medicine submitted by one is refused by the backend as well as hidden in the app.

### DR-15-03 Write an advice and therapy plan

As any provider, I want to record what was covered, home practice, next-session
focus and warning signs, so that the patient leaves with a plan.

- The plan is available to every provider, prescribing or not, and is the closing record for a non-prescribing one.
- Warning signs entered here surface on the patient's care plan.

### DR-15-04 Record referral advice

As a provider, I want to write in-person or emergency referral advice, so that
the patient knows to seek care elsewhere.

- The referral note is free text and is what the patient sees; there is no separate yes/no toggle.

### DR-15-05 Finalise the case

As a provider, I want to finalise the record and know the case is closed
properly, so that nothing is left half-written.

- Finalising requires the prescription or the advice and therapy plan, and a case summary of three to five lines.
- A finalised record freezes; a correction is an addendum, not an edit.
- Finalising releases the instant-consult completion gate.
- `POST /v1/doctor/consultations/:consultationId/clinical-record/finalise`

### DR-15-06 Recommend self-help to this patient

As a provider, I want to pick items from the Care Hub for this patient, so that
they have something structured between sessions.

- Recommendations are chosen from published content only and are recorded against the consultation.
- The patient sees them marked as recommended by me.
- `GET /v1/care-hub/items`

## M-10 Documents and Report Requests

### DR-10-01 Read my patient's documents

As a provider, I want the patient's history and reports from my own
consultations with them, so that I can see the trajectory.

- I see files from every consultation of mine with that patient, including history uploaded before the first session.
- I cannot reach a patient who is not mine, and the refusal is a not-found state.
- `GET /v1/doctor/patients/:patientId/files`, `GET /v1/doctor/files/:fileId/download-url`

### DR-10-02 Ask the patient for a report

As a provider, I want to request a specific report and say why, so that it
arrives labelled instead of as an unnamed attachment.

- A request names what is needed and why, and notifies the patient.
- I see open, fulfilled and cancelled requests on the consultation, and can cancel one that is no longer needed.
- `POST /v1/doctor/report-requests`, `POST /v1/doctor/report-requests/:requestId/cancel`, `GET /v1/consultations/:consultationId/report-requests`

## M-16 Follow-Up and Patient Safety

### DR-16-01 Assign a follow-up pathway

As a provider, I want to choose the check-in pathway, its start and its
duration, so that follow-up fits the patient rather than a default.

- Pathways are read from the backend: depression and anxiety, sleep, substance use, bipolar and psychosis, and general follow-up.
- I set from when and for how long, and I can cancel an assigned pathway.
- `GET /v1/doctor/followup-pathways`, `POST /v1/doctor/consultations/:consultationId/followup`, `POST /v1/doctor/consultations/:consultationId/followup/cancel`

### DR-16-02 Add questions for one patient

As a provider, I want to add my own check-in questions for a specific patient,
so that I can track what matters in their case.

- Added questions appear alongside the pathway questions, for that patient only.
- The screen states that my own questions never trigger safety alerts.

### DR-16-03 Work my safety alerts

As a provider, I want red and amber alerts about my patients in a queue, so that
I act on the ones that matter first.

- Alerts arrive by push and appear in a queue ordered by severity and age.
- Each alert opens the patient's check-in history and the consultation behind it.
- I can acknowledge an alert and close it, and both actions are attributed to me.
- `GET /v1/doctor/safety-alerts`, `POST /v1/doctor/safety-alerts/:alertId/acknowledge`, `POST /v1/doctor/safety-alerts/:alertId/close`

### DR-16-04 Review a patient's check-in history

As a provider, I want to see the run of daily answers, so that I can judge
whether things are improving before the follow-up.

- The history shows each day's status and the answers behind it, with missed days visible as missed.
- `GET /v1/doctor/consultations/:consultationId/checkins`

## M-17 Case Clarification

### DR-17-01 Ask an expert about a case

As a treating provider, I want to post a de-identified case for expert review,
so that I can get a second opinion without exposing my patient.

- The form takes title, age and gender, brief history, diagnosis, current plan, the specific doubt, urgency and attachments.
- Direct identifiers are stripped before the case is shared, and the app shows me what will be shared before I post.
- I can save a draft, post it, and follow its status through Draft, Posted, Awaiting Response, Response Received, Clarification Asked, Reviewed and Closed.
- Nothing from the case reaches the patient automatically, and the screen says so.
- `GET /v1/doctor/clarification-cases`, `POST /v1/doctor/clarification-cases`, `PATCH /v1/doctor/clarification-cases/:caseId`, `POST /v1/doctor/clarification-cases/:caseId/post`

### DR-17-02 Discuss and close a case

As a treating provider, I want to reply to the expert and close the case, so
that the thread ends in a decision.

- I can reply, ask for clarification, mark reviewed and close.
- The full thread stays readable after closure.
- `POST /v1/doctor/clarification-cases/:caseId/reply`, `POST /v1/doctor/clarification-cases/:caseId/reviewed`, `POST /v1/doctor/clarification-cases/:caseId/close`

### DR-17-03 Answer as an expert

As an expert provider, I want to see only the cases shared with me and respond,
so that I can advise without any access I should not have.

- My expert queue shows only cases assigned to me, and no direct identifier appears anywhere in them.
- I can comment, give clinical considerations, ask for clarification, or advise bringing the follow-up forward.
- Expert level is granted by an admin; without it the queue is absent, not empty.
- `GET /v1/doctor/expert-reviews`, `GET /v1/doctor/expert-reviews/:caseId`, `POST /v1/doctor/expert-reviews/:caseId/reply`

## M-12 Payout (provider view)

### DR-12-01 See what I am owed

As a provider, I want my payout per consultation and in total, so that I can
reconcile my earnings.

- The payout view shows the full consultation fee with zero platform deduction, and the payout status.
- Figures reconcile with my own consultation list.
- `GET /v1/doctor/payouts`, `GET /v1/doctor/consultations/:consultationId/payout`

## M-19 Feedback (provider view)

### DR-19-01 Read my feedback

As a provider, I want to see the feedback patients left on my consultations, so
that I can improve.

- Feedback appears against the consultation it belongs to.
- Complaints are handled by an admin; the app shows me only what an admin has shared with me.

## M-08 Notifications (provider)

### DR-08-01 Be alerted to what needs me

As a provider, I want push and in-app alerts for the things I must act on, so
that nothing waits on me unseen.

- Instant requests, red-flag and amber alerts, pending documentation and patient report uploads each arrive and deep-link to the right screen.
- No notification names a diagnosis.
- Copy comes from the backend and changes without an app release.
- Push registration, permission refusal and background delivery are all handled.
- `GET /v1/me/notifications`, `GET /v1/me/notifications/unread-count`, `POST /v1/me/notifications/:notificationId/read`

---

# Part C — Stories That Apply to Both Apps

These live in the shared package. They are written once and verified in both
apps, because two implementations would drift.

### SH-01 One API client, one error shape

As an engineer, I want a single API client with the platform's error shape, so
that both apps fail in the same readable way.

- Every endpoint failure renders as a message, never a raw payload or status code.
- 401 triggers one refresh attempt then sign-out; 403 renders as a permission state; 404 on an owned resource renders as not-found without hinting at existence.

### SH-02 Role-scoped sign-in

As an engineer, I want each app to accept only its own account kind, so that a
wrong-app sign-in fails identically in both.

- The refusal copy is shared, names the correct app, and never reveals whether the account exists.

### SH-03 Offline and poor-connection behaviour

As a user on a weak connection, I want the app to hold up, so that I do not lose
a consultation or a form.

- Form input survives a backgrounded app and a failed request.
- The video screen degrades and reconnects rather than dropping the consultation.
- Read screens show a stale-data state rather than an empty one when a refresh fails.

### SH-04 Accessibility and language

As a user reading in Hindi or with a screen reader, I want the app usable, so
that care is not gated on English or eyesight.

- All copy is externalised; no user-visible string is hardcoded in a screen.
- Touch targets, contrast and screen-reader labels meet the platform baseline on every primary flow.

---

## 2. Module Coverage

| Module | Patient app | Doctor app | Notes |
| --- | --- | --- | --- |
| M-01 Platform Foundation | — | — | Backend only; surfaces as SH-01 |
| M-02 Identity and Access | PT-02-01..03 | DR-02-01..02 | |
| M-03 Consent and Legal | PT-03-01..03 | — | Provider consent is handled at admin onboarding |
| M-04 Patient Profile | PT-04-01..02 | — | |
| M-05 Doctor Registry | — | DR-05-01..03 | No patient-facing directory (v1.3 removal) |
| M-06 Catalogue and Allocation | PT-06-01 | — | Admin-authored; both apps read it |
| M-07 Availability | PT-07-01 | DR-07-01..03 | |
| M-08 Notifications | PT-08-01 | DR-08-01 | |
| M-09 Search and Concern Mapping | PT-09-01..03 | — | |
| M-10 Documents and Files | PT-10-01..03 | DR-10-01..02 | |
| M-11 Booking | PT-11-01..06 | DR-11-01..03 | Assignment is backend-only |
| M-12 Payments | PT-12-01..03 | DR-12-01 | |
| M-13 Instant Consult | PT-13-01 | DR-13-01..03 | |
| M-14 Video | PT-14-01..02 | DR-14-01 | |
| M-15 Clinical Records | PT-15-01..02 | DR-15-01..06 | |
| M-16 Follow-Up and Safety | PT-16-01..04 | DR-16-01..04 | |
| M-17 Case Clarification | — | DR-17-01..03 | Never reaches the patient automatically |
| M-18 Care Hub | PT-18-01..02 | DR-15-06 | Provider side is the recommendation action |
| M-19 Feedback and Complaints | PT-19-01..02 | DR-19-01 | |
| M-20 Governance | — | — | Admin panel only |
| M-21 Audit and Data Rights | PT-21-01 | — | Provider audit is admin-facing |

Story count: 33 patient, 27 doctor, 4 shared.

---

## 3. Known API Gaps

Stories written against a contract the backend does not yet expose to that role.
Each needs a backend change before the story can be closed.

| Gap | Story | What is missing |
| --- | --- | --- |
| G-1 | PT-07-01 | No patient-facing slot lookup. `GET /v1/me/doctor/slots` is the provider's own diary and `GET /v1/admin/doctors/:doctorId/slots` is admin-scoped. The patient app needs coverable times for a *service*, not a person — otherwise the time picker is guesswork corrected by a booking refusal. |
| G-2 | DR-07-03 | `GET /v1/availability/remaining` is on the admin controller only. A provider cannot see their own remaining free duration, which is what explains why assignments are or are not reaching them. |
| G-3 | DR-19-01 | No provider-facing feedback read. Patient feedback is written at `PUT /v1/me/consultations/:consultationId/feedback` and read back by the patient and by admin; the doctor app has no endpoint for it. |
| G-4 | PT-11-03 | Intake answers and the specialty intake form have no dedicated patient endpoint in the shipped controllers. Confirm whether they ride on the booking body or need their own contract before Day 3 of the integration plan. |

---

## 4. Out of Scope for These Apps

- Any browsable, filterable list of providers in the patient app. SRS 4.2 makes the patient's view of a provider the outcome of an assignment.
- Prescription and therapy-plan templates. Deferred; see SRS section 11.
- Peer groups and open discussion forums in the Care Hub.
- Video or audio recording of consultations.
- Registration certificate expiry tracking in the doctor app.
- Server-side search query logging; recent searches live on the device.
