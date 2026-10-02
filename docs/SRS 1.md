# Software Requirements Specification

## Doctor Consultation Platform

Version 1.2
Date: 1 September 2026
Prepared by: Synquic
Prepared for: Dr Aviraj Kamraj Shambushankar
Status: Draft for approval

Version 1.2 changes how a patient reaches a provider. **The patient no longer
chooses their doctor.** The system assigns one, from the specialty the patient
needs and the language they prefer, within the language and region pools an
admin maintains. It also splits provider registration into two forms, doctors
and non-doctor healthcare providers. These are client instructions of 1
September 2026; they supersede FR-4.1 to FR-4.4 as written in version 1.1.
Changes, and the four decisions they leave open, are listed in section 14.

---

## 1. Introduction

### 1.1 Purpose

This document states the software requirements for a psychiatry-first doctor consultation platform for the Indian market. It covers a role-based mobile app for patients and doctors and a separate admin web panel. It is written for the client, the development team, testers and reviewers.

### 1.2 Product Scope

The platform is a clinically governed consultation system, not a video-call marketplace. It supports online booking, payment, video consultation, mandatory clinical documentation, structured seven-day follow-up with safety alerts, patient education, internal expert case clarification and transparent billing where the doctor keeps the full consultation fee.

Launch specialties: psychiatry, psychology, therapy, counselling and de-addiction. The system is built so more specialties can be added later from the admin panel without a new app build.

### 1.3 Definitions and Abbreviations

- Care Hub: post-consultation library of self-help tools, education modules, blogs, caregiver guides and support directory.
- Care Plan: single patient screen holding prescription, daily check-in, recommended self-help, follow-up booking and warning signs.
- Available Now: doctor state that allows instant consultation requests.
- Case summary: mandatory 3 to 5 line clinical summary written by the doctor after each consult.
- Case clarification: internal, de-identified request for opinion from a senior or expert doctor.
- Pathway: the follow-up question set assigned to a patient after consultation.
- Red flag: a patient response that indicates a safety concern and triggers alerts.
- Concern taxonomy: the fixed list of psychiatry concerns that symptom queries map to.
- Consult: one consultation session, scheduled or instant.
- OTP: one-time password sent by SMS.
- MDR: merchant discount rate charged by the payment gateway.
- UAT: user acceptance testing.

### 1.4 References

- Synquic Proposal, Doctor Consultation Platform, 4 August 2026.
- Client planning brochure for the platform.
- Telemedicine Practice Guidelines and applicable medical council regulations (client responsibility).

### 1.5 Document Overview

Section 2 describes the product at a high level. Section 3 defines external interfaces. Section 4 lists functional requirements by module. Section 5 lists data requirements. Sections 6 to 8 cover non-functional requirements, constraints and compliance. Sections 9 to 12 cover delivery, acceptance, out-of-scope items and the future roadmap.

---

## 2. Overall Description

### 2.1 Product Perspective

Three deployable parts share one backend:

1. Two React Native applications, patient and doctor, each published as its own store listing on iOS and Android, sharing an internal package of API client, types and common components. Subject to the confirmation noted in section 2.4.
2. Admin web panel, React.js.
3. Backend REST API, NestJS on Node.js, with PostgreSQL.

External services: Razorpay for payments, LiveKit for video calls, a hosted language model for symptom interpretation, Firebase Cloud Messaging and APNs for push, Slide for OTP issue and verification, and the client's cloud account for hosting.

### 2.2 User Classes

There are exactly three kinds of account, each held in its own table, because
each is created a different way. The table an account lives in is its role;
there is no shared user record and no role column.

- Patient. Signs up alone by mobile OTP, with no password. Can search, book, pay, consult, view prescriptions, complete daily check-ins, use the Care Hub and raise complaints. Sees only their own records.
- Provider. Never self-registers. An admin creates the account, the provider uploads credentials, an admin approves each credential individually, then approves the provider and lists them. Sets availability, runs consultations, writes notes and prescriptions or advice, assigns follow-up plans, sees alerts and earnings. Sees only their own patients. A provider is registered on one of two forms, and the form follows from the specialty chosen for them:
  - **Doctor.** Medically qualified, holds a medical council registration number, and may prescribe medicines where the specialty allows it. Psychiatry at launch.
  - **Non-doctor healthcare provider.** Psychologists, therapists and counsellors. Holds a professional qualification but no medical council registration, and issues advice and a therapy plan rather than a prescription.
  Both sign in through the same provider application and are the same kind of account. The word "doctor" is used for both throughout this document and in the database, where the table is named `doctors`; where the distinction matters it is called out as doctor or non-doctor explicitly. See section 14 for the naming decision this leaves open.
- Admin. Created by another admin, signs in by email and password. Uses the web panel. Manages doctors, specialties, appointments, payments, refunds, content, governance queues and quality metrics, limited by permission level.

Two roles named in version 1.0 are no longer separate account types:

- Expert doctor is not a role. It is a level on the doctor record, granted and revoked by an admin. An expert signs in through the doctor app like any other doctor. Being an expert makes a doctor eligible to be asked; it does not by itself let them see anything. Each case is assigned to one expert, and that assignment is what grants sight of that one de-identified case.
- Care coordinator is not a role. It is an admin permission level. An admin at this level receives and acts on safety and follow-up alerts and sees nothing else.
- Service account is removed. The payment gateway webhook carries no user identity at all. It is authenticated by verifying the HMAC signature on the raw request body, which is stronger than issuing it an account.

### 2.3 Operating Environment

- Mobile app on current supported iOS and Android versions, published to the App Store and Google Play under the client's developer accounts.
- Admin panel on current desktop browsers.
- Backend on the client's cloud account, HTTPS everywhere.

### 2.4 Design and Implementation Constraints

- The patient and doctor applications are published as two separate store listings, sharing one API client, one type package and a common component library. This supersedes the single-codebase statement in version 1.0 and follows the Module Plan. Confirmation from the client is outstanding; the decision affects store accounts, push credentials and release scheduling, and is needed before Week 3.
- Every API endpoint enforces role-scoped authorisation.
- No routine video or audio recording of consultations in this release.
- Community peer groups and open discussion forums are excluded by design.
- The AI module assists navigation only. It must not screen, diagnose, triage clinical severity or influence treatment, and the interface must state this.
- Doctor payouts are reported in the dashboard but paid manually by the client.
- Clinical and educational content is authored and clinically reviewed by the client, not the developer.

### 2.5 Assumptions and Dependencies

- The client provides doctor data with verified qualifications and registration numbers before any listing goes live.
- The client provides all clinical content, follow-up question wording, red-flag thresholds and the symptom-to-specialty mapping, approved by a qualified clinician.
- The client provides legal copy: privacy policy, terms of use, teleconsultation consent, refund and reconsult policy.
- The client confirms GST and invoice structure with its CA or legal advisor.
- Accounts for the stores, Razorpay, LiveKit, Slide, AI provider and cloud are created in the client's name.
- The product name and logo are adopted only after trademark, domain and store availability checks.
- Design and demo feedback is returned within three business days.

---

## 3. External Interface Requirements

### 3.1 User Interfaces

- Patient bottom navigation: Home, Appointments, Care Plan, Care Hub, Profile.
- Doctor bottom navigation: Dashboard, Appointments, Cases, Availability, Profile.
- Admin panel: left navigation by module, with role-restricted sections.
- All wording is plain English. Notifications never name a diagnosis.
- Emergency guidance is always reachable and clearly worded.
- The AI-assisted search is reachable from the patient home screen and from an assistant entry available on patient screens.

### 3.2 Hardware Interfaces

- Device camera, microphone and speaker for video consultation, with a pre-call device and permission check.
- Device storage and camera roll for report and photo upload.
- Push notification services on the device.

### 3.3 Software Interfaces

- Razorpay: payment order creation, checkout, webhook confirmation, refunds.
- LiveKit: video conferencing SDK for the consultation call. Room creation, server-issued join tokens, mute and camera controls, participant events and session metadata. Used through the LiveKit React Native SDK in the app and the LiveKit server SDK in the backend.
- Hosted language model: interprets free-text symptom queries; output is constrained by a curated mapping layer.
- Slide: OTP issue and verification for patient and doctor sign-in, and for admin two-factor challenge. Slide owns OTP generation, expiry and attempt state; the platform stores only the fact and time of a successful verification. Slide's own rate limits must be confirmed in writing and recorded here before build, because FR-1.9 makes rate limiting the platform's obligation and the platform can only enforce what it can see.
- Firebase Cloud Messaging and APNs: push delivery.
- PostgreSQL: primary data store, accessed through Drizzle ORM.

### 3.4 Communication Interfaces

- REST over HTTPS between clients and backend.
- Realtime channel for doctor presence and instant-consult request routing.
- Webhooks from the payment gateway.

---

## 4. Functional Requirements

### 4.1 Authentication, Roles and Access

- FR-1.1 A patient signs up by mobile number and OTP without admin help. A patient never has a password.
- FR-1.2 A provider account is created by an admin only. Self sign-up as a provider is not allowed. A provider signs in by mobile number and OTP. The admin creates the account on one of two registration forms, doctor or non-doctor healthcare provider; which form is used follows from the specialty and decides which credentials the provider must submit and whether they may prescribe. See FR-19.7.
- FR-1.3 An admin account is created by another admin and signs in by email and password.
- FR-1.4 Each kind of account is a separate record. A sign-in attempt against the wrong application is refused with a plain message: the patient app accepts patient accounts only, the doctor app accepts doctor accounts only, and the panel accepts admin accounts only.
- FR-1.5 The backend checks ownership on every request. A patient can read only their own records. A doctor can read only patients they have consulted and their own cases. An admin sees only what their permission level allows.
- FR-1.6 An admin can raise or lower a doctor to expert level, and can revoke it. Expert level makes a doctor eligible to be asked for a case opinion. It grants no visibility on its own.
- FR-1.7 Admin accounts have permission levels that limit which panel sections and data they see. The care-coordinator level is the narrower one that receives safety and follow-up alerts.
- FR-1.8 Login credentials expire and can be revoked. Each account stores one current device login, including its `push_token` and `device_id`; a new sign-in replaces the previous login, and revocation clears or disables notification delivery.
- FR-1.9 OTP issue and verification, and admin login, are rate limited. OTP challenge state is held by Slide, so the platform enforces its own limit from the audit log in addition to whatever Slide applies. Every attempt, successful or not, is written to the audit log.
- FR-1.10 An admin account may have two-factor authentication enabled. When enabled, a correct password is followed by an OTP challenge through Slide before login credentials are issued. The setting is per account and is switched by a super admin.

### 4.2 Patient Onboarding and Consent

- FR-2.1 Splash and first-run screens introduce the platform.
- FR-2.2 The patient completes a basic profile: name, age, gender, contact and language.
- FR-2.3 The app captures explicit teleconsultation consent before the first consultation and records the consent version, timestamp and user.
- FR-2.4 The patient can view the privacy policy, terms of use and refund policy in the app.
- FR-2.5 The patient can request data deletion through a defined workflow.

### 4.3 Patient Home and Navigation

- FR-3.1 Home shows a greeting header.
- FR-3.2 Home shows the next upcoming appointment with a Join Consultation action.
- FR-3.3 Home shows main actions, a Your Care Plan entry, a Care Hub entry and recent activity.
- FR-3.4 Home shows a safety and support block with emergency guidance.

### 4.4 Service Selection and Provider Assignment

**Changed in version 1.2.** The patient chooses a service, not a person. There
is no doctor directory, no doctor browse and no doctor filter in the patient
application, and no screen on which a patient picks one provider over another.

- FR-4.1 The patient picks a service: psychiatrist, psychologist or therapy, de-addiction, sleep and stress, or follow-up. This chooses a **specialty**, which is the only provider-facing choice the patient makes.
- FR-4.2 **The system assigns the provider.** The patient never selects one. Assignment is made at booking from the specialty needed and the patient's preferred language, within the language and region pools an admin maintains, and only from providers who are verified, listed and available for the requested time. See section 4.20.
- FR-4.3 Once assigned, the patient sees that provider's profile in full: name, qualification, registration number where they hold one, years of experience, languages, specialty and consultation duration. The patient is told who they are consulting before the consultation begins, which the Telemedicine Practice Guidelines require. It is shown as the outcome of an assignment, never as one option among several.
- FR-4.4 The patient can decline an assigned provider and ask for another, giving a reason, up to a configured limit per booking. The limit is an admin setting, not a constant. Past the limit the patient continues with the provider assigned or cancels. Each decline and its reason are recorded, so a provider declined repeatedly is visible to the client rather than invisible.
- FR-4.5 A provider is registered under one specialty at launch, which is what decides prescribing eligibility and which pool they are assigned from. Multiple specialties per provider is a Phase 1.5 item; see section 11.

### 4.5 AI-Assisted Symptom and Category Search

- FR-5.1 The patient can describe a problem in plain words and be routed to the right **service and concern**. Input may be English, Hindi or mixed Hindi-English, including common synonyms and informal phrasing. **Changed in version 1.2:** the search returns specialties and concerns, never a list of doctors to pick from. Its output is the input to assignment, not a shortlist.
- FR-5.2 The system maps a query to a psychiatry concern taxonomy covering depression, anxiety, sleep, OCD, substance use, psychosis, child and adolescent, women's mental health and elderly care.
- FR-5.3 The patient can instead browse or search directly by professional type: psychiatrist, psychologist or therapist, counsellor, de-addiction specialist. This selects a specialty, not a person. The same taxonomy extends to future specialties.
- FR-5.4 Results are ranked and each result shows a plain-language reason, for example "matched to: sleep, anxiety". **Changed in version 1.2:** a result is a specialty or concern with the fee and the soonest available time for that service, not a named provider with their own fee and availability.
- FR-5.5 An optional concern guide handles the "unsure whom to consult" flow using the same engine. It is never forced before booking.
- FR-5.6 If a query contains self-harm or crisis language, the system interrupts the booking flow and shows emergency guidance instead of search results.
- FR-5.7 The symptom-to-specialty mapping, synonym list and crisis keyword list are editable from the admin panel without an app release.
- FR-5.8 The interface states plainly that the module recommends whom to consult and does not screen, diagnose or make clinical decisions.
- FR-5.9 The module is reachable in two ways: the search on the patient home screen, and an assistant entry available on patient screens that opens over the current screen and returns the patient to it. Both use the same engine, mapping and crisis guardrail, and both are optional.
- FR-5.10 The patient can speak the query instead of typing it, in the same languages the typed search accepts.
- FR-5.11 The search shows the patient their own recent searches, held on the device rather than on the server, and a popular searches list that the admin edits without an app release. Queries are not logged server-side in this release.

### 4.6 Booking

- FR-6.1 The patient can start a Consult Now instant request or Book Appointment on a scheduled slot. In both cases the patient chooses a service and a time, never a provider; the provider is assigned under section 4.20. Scheduled slots are offered as the times the specialty's pool can cover, not as one provider's diary.
- FR-6.2 A selected slot is held for the patient during checkout and released on timeout or failure.
- FR-6.3 The patient can attach reports and photos to a booking for the doctor to review before the consult.
- FR-6.4 The patient can reschedule or cancel within the configured policy, with refund status shown.
- FR-6.5 The Appointments screen lists upcoming and past consults with join-call, reschedule, cancel and refund status.

### 4.7 Payment and Billing Display

- FR-7.1 Payment is taken through Razorpay: UPI, cards, netbanking and wallets.
- FR-7.2 The patient bill shows every component separately: doctor consultation fee, convenience fee, subtotal before GST, GST, and final payable.
- FR-7.3 Worked example at a fee of 500 rupees: convenience fee is 20 percent, which is 100 rupees; subtotal is 600 rupees; GST at 18 percent exclusive is 108 rupees; final patient payable is 708 rupees.
- FR-7.4 The doctor payout view for the same consultation shows consultation fee 500 rupees, platform deduction 0 rupees, doctor earning 500 rupees.
- FR-7.5 The convenience fee percentage and GST rate are configurable from the admin panel.
- FR-7.8 **Added in version 1.2.** The consultation fee is set **per specialty**, not per provider. The patient is quoted a price before a provider is assigned, so the price cannot depend on who is assigned. Two patients booking the same service pay the same, whoever takes the consultation.
- FR-7.9 **Added in version 1.2.** What a provider is paid is a separate figure from what the patient is charged, and may differ between providers of the same specialty. FR-7.4's payout view reports the provider's own figure. Changing a specialty fee never rewrites an issued invoice: the billed amounts are frozen on the payment row at checkout.
- FR-7.6 Payment status is confirmed by gateway webhook, not by client-side result alone.
- FR-7.7 Refunds are initiated from the admin panel and their status is visible to the patient.

### 4.8 Video Consultation

- FR-8.1 The consult runs inside the app on a LiveKit room. No browser redirect and no external meeting link.
- FR-8.2 A pre-call check verifies camera, microphone and network permissions before joining.
- FR-8.3 Both sides have mute and camera controls.
- FR-8.4 The doctor consultation room shows patient details, uploaded documents, consent status and prior history on the same screen as the call.
- FR-8.5 A LiveKit room is created for each consultation. The backend issues short-lived join tokens only to the assigned patient and doctor, after payment and consent checks pass.
- FR-8.6 Session metadata, including join and leave times and call duration, is stored and linked to the consultation ID. Video and audio are not recorded.

### 4.9 Doctor Experience

- FR-9.1 The doctor dashboard shows a greeting with current status, availability controls and a today summary: appointments, completed, upcoming, cancelled or no-show, and pending summaries.
- FR-9.2 The next appointment card shows patient initials, age and gender, presenting concern, time, payment status, View Details and Join Consultation.
- FR-9.3 A pending clinical tasks worklist surfaces pending case summaries, prescription drafts, incomplete notes and follow-up responses.
- FR-9.4 The doctor records structured clinical notes: history, diagnosis or provisional diagnosis.
- FR-9.5 The doctor issues an e-prescription and advice through a structured form that generates the patient PDF.
- FR-9.6 Reusable prescription and therapy-plan templates are deferred to a later release. They save the doctor typing but nothing depends on them, so they are out of scope for launch. See section 11.
- FR-9.7 The doctor assigns a follow-up pathway and review date, which drives the patient's daily check-ins.
- FR-9.8 The doctor sees per-patient follow-up alerts: red flag, amber alert, missed check-in, medication side effect and follow-up due.
- FR-9.9 The doctor sees completed consultations, estimated payout and payout status.

### 4.10 Availability, Scheduled Booking and Available Now

- FR-10.1 The doctor sets weekly and date-wise slots, consultation duration, buffer time, blocked dates and leave. The admin can see and edit these from the panel, because availability is what assignment draws on and an absent provider must be removable from the pool without waiting for them to update their own diary.
- FR-10.2 In Available Now the doctor is live for instant consultation: the patient requests, the doctor accepts within a time window, the patient pays, and the video consult starts.
- FR-10.3 In Scheduled Only the doctor stays bookable by slot but receives no instant requests.
- FR-10.4 The system implements seven doctor states: Offline, Available Now, Request Pending, In Consultation, Completing Notes, Paused, Scheduled Only.
- FR-10.5 Completion gate: after an instant consultation, no new instant request is routed to that doctor until the prescription or advice and the case summary are finished.
- FR-10.6 Instant requests have an acceptance window and timeout. On decline or timeout the request is automatically re-routed to the next available doctor, chosen by the same rules as any other assignment (section 4.20).
- FR-10.7 **Added in version 1.2.** Assignment considers how much unbroken availability a provider has at the requested time, not merely whether they are free at its start. A provider whose remaining window is shorter than the consultation duration plus its buffer is not assignable for that slot. The admin panel shows available duration per provider for a chosen time, which is how an admin checks and overrides an allocation.

### 4.11 Clinical Documentation and Case Summary

- FR-11.1 Mandatory fields per consultation: chief complaint, brief clinical history, diagnosis or provisional diagnosis, risk category as low, moderate or high, follow-up plan, and whether an in-person or emergency referral was advised.
- FR-11.2 Prescription or advice is mandatory where applicable.
- FR-11.3 A brief case summary of 3 to 5 lines is mandatory.
- FR-11.4 An optional clinical doubt flag feeds the case clarification module.
- FR-11.5 A consultation is marked clinically complete only after the prescription or advice is finalised and the case summary is submitted. This rule is enforced by the system, not by convention.
- FR-11.6 Each consultation has a consultation ID that ties together booking, video session metadata, prescription and case summary for audit.

### 4.12 Case Clarification and Expert Opinion

- FR-12.1 A treating doctor can post a de-identified case for guidance from senior doctors or an expert panel.
- FR-12.2 Name, phone, address, email and other direct identifiers are stripped before sharing.
- FR-12.3 Case fields: title, age and gender, brief history, diagnosis, current plan, the specific doubt, urgency, and attachments where needed.
- FR-12.4 An expert sees only the queries assigned to them and nothing else. Two separate checks apply: expert level decides who may be asked, and the assignment on the case decides what they may see. Eligibility alone never grants visibility.
- FR-12.5 An expert can comment, suggest clinical considerations, ask for clarification, or recommend early or in-person follow-up.
- FR-12.6 Status tracking: Draft, Posted, Awaiting Response, Response Received, Clarification Asked, Reviewed, Closed.
- FR-12.7 Internal case discussion is never automatically visible to the patient. The treating doctor decides all patient communication and remains responsible for the final treatment plan.

### 4.13 Seven-Day Follow-up and Patient Safety

- FR-13.1 Daily check-in question sets are pathway-specific, with distinct sets for depression and anxiety, sleep problems, substance use, bipolar and psychosis, and general follow-up.
- FR-13.2 Green status means stable or improving. Check-ins and the care plan continue.
- FR-13.3 Amber status means worsening, missed medicines, side effects or a missed check-in. It prompts a follow-up booking or doctor review.
- FR-13.4 Red status means a safety concern. It shows emergency guidance immediately and raises a configurable alert to the doctor and to the admin or care coordinator.
- FR-13.5 Red-flag detection covers self-harm thoughts, severe worsening, confusion or agitation, violence risk, severe withdrawal, medication side effects and feeling unsafe.
- FR-13.6 Follow-up booking lets the patient continue with the same doctor, or book the earliest available doctor when review is urgent.
- FR-13.7 Pathway question sets and red-flag rules are authored by the admin and configurable from the admin panel without an app release. The wording is held centrally because it is clinical content requiring clinician sign-off under section 8, and because red-flag rules must fire identically for every patient.
- FR-13.8 The treating doctor may add questions for one patient on top of the assigned pathway set. Doctor-added questions collect answers only. They carry no red-flag rules, so safety alerting stays on the clinician-approved set.

### 4.14 Care Plan

- FR-14.1 The Care Plan screen holds the prescription, the daily check-in, doctor-recommended self-help, follow-up booking and warning signs in one place.
- FR-14.2 The patient can view and download the prescription PDF, with warning signs and the doctor's follow-up plan.

### 4.15 Post-Consultation Care Hub

- FR-15.1 Self-help tools: breathing exercise, grounding technique, sleep hygiene, activity scheduling, craving diary, medication adherence tips.
- FR-15.2 Patient education library with condition-wise modules across depression, anxiety, sleep, OCD, substance use, psychosis, child and adolescent, women's and elderly mental health.
- FR-15.3 Blogs and articles: clinician-reviewed awareness content on treatment literacy, stigma, medicine myths, therapy education and family support.
- FR-15.4 The doctor can select specific tools after a consult; the patient sees them tagged "Recommended by your doctor".
- FR-15.5 Caregiver and family guide covering warning signs, adherence, relapse signs, communication and emergency support, shareable with the patient's consent.
- FR-15.6 NGO and support directory of curated external services and helplines with contact, location, timings and verification status.
- FR-15.7 Persistent, clearly worded emergency guidance for urgent in-person care.
- FR-15.8 No community peer groups or open discussion forums in this release.

### 4.16 Notifications

- FR-16.1 Push and in-app reminders for booking confirmed, consult reminder, doctor joined, prescription ready and check-in due.
- FR-16.2 Notification text never names a diagnosis.
- FR-16.3 Notification copy is editable from the admin panel.
- FR-16.4 Doctors receive notifications for instant requests, red-flag and amber alerts, and pending documentation.

### 4.17 Feedback, Support and Emergency Guidance

- FR-17.1 The patient can submit post-consult feedback.
- FR-17.2 The patient can raise a complaint and track its resolution.
- FR-17.3 The app states clearly that it is not for acute emergencies and shows what to do instead.

### 4.18 Admin Web Panel

- FR-18.1 Provider management: add on either registration form, approve, remove, verify registration, edit profiles, manage fee and instant-consult permission, assign the expert role.
- FR-18.9 **Added in version 1.2.** Allocation management: maintain the language and region pools each provider belongs to, set the allocation policy, see which providers are assignable for a given service, language, region and time with their available duration, and override or reassign an individual consultation with the reason recorded. See section 4.20.
- FR-18.2 Specialty management: add specialties, intake forms and prescription templates later without rebuilding the app.
- FR-18.3 Appointment management: scheduled and instant consults, cancellations, no-shows and rescheduling.
- FR-18.4 Payment and refund management: transactions, doctor payouts, refunds and CSV export.
- FR-18.5 Clinical governance: pending case summaries, high-risk alerts, follow-up alerts and the case clarification tracker.
- FR-18.6 Quality dashboard: completed cases, pending summaries, red flags, follow-up alerts, complaints, and doctor reliability metrics covering acceptance rate, no-show rate and case summary completion.
- FR-18.7 Content management: information pages, self-help resources, education library, blogs, NGO directory, follow-up questions and notification copy.
- FR-18.8 Feedback and complaints: patient feedback review, complaint workflow and resolution tracking.

### 4.19 Multi-Specialty Readiness

- FR-19.1 Specialties are admin-configurable, so general medicine, dermatology, gynaecology, paediatrics, dietetics and others can be added from the panel.
- FR-19.2 Intake forms are specialty-wise, because pre-consult data differs by specialty.
- FR-19.3 Red flags are configurable per specialty and per condition, so emergency warnings adapt as specialties are added. Two distinct things are configured: the runtime rules that turn a daily check-in answer red, which are held with the follow-up pathway and are therefore condition-wise; and the reference material a doctor reads during a consultation, which is held as clinical reference content and is specialty-wise. The client must confirm that this split matches clinical intent before the follow-up module is built.
- FR-19.4 Prescription templates are specialty-wise.
- FR-19.5 Report and photo upload is already part of the consultation flow for all specialties.
- FR-19.6 The data model is prepared for a chronological timeline health record and for lab or pharmacy partners, so those can be enabled later without rebuilding the prescription and report flows.
- FR-19.7 **Added in version 1.2.** Each specialty declares which of the two registration forms it uses, doctor or non-doctor healthcare provider. That declaration, and not a separate field on the provider record, is what decides which credentials the provider must submit, whether a medical council registration number is required, and whether the specialty may prescribe. Adding a specialty of either kind is an admin action with no code change and no app release.
- FR-19.8 **Added in version 1.2.** Regions are admin-configurable in the same way as specialties. Adding a region, and putting providers into it, needs no code change and no app release.

### 4.20 Provider Allocation

**Added in version 1.2.** This section replaces patient-led doctor selection.

- FR-20.1 Every consultation is assigned to exactly one provider by the system. A patient cannot choose, request or be shown a choice of provider.
- FR-20.2 Assignment takes four inputs: the **specialty** the service requires, the patient's **preferred language**, the patient's **region**, and the provider's **availability for the requested time** including the duration still free at that moment (FR-10.7).
- FR-20.3 Only providers who are verified, listed and not suspended are assignable. Verification and listing remain two separate admin actions.
- FR-20.4 Language is a hard requirement. A provider who does not speak the patient's preferred language is never assigned to them.
- FR-20.5 Region is a **preference, not a hard requirement**. Assignment prefers a provider in the patient's region and, where none is free, assigns outside it and records that the region was relaxed. A patient is never left unable to book because their region's pool is thin. Language is not relaxed this way; see FR-20.4.
- FR-20.11 A region is a **state or province**. Regions are rows an admin maintains (FR-19.8), so the granularity can change later without a release, but the launch set is states.
- FR-20.6 Where more than one provider qualifies, the tie is broken by a policy the admin sets, and the policy is configuration rather than code. Load balancing across the pool is the default, so work spreads evenly rather than landing on whichever provider sorts first.
- FR-20.7 Where no provider qualifies, the patient is told so plainly and offered the next time the pool can cover, and the failed attempt is recorded with the inputs that produced it. A silent fallback to a provider who does not meet the criteria is never acceptable.
- FR-20.8 An admin can override an assignment and reassign a consultation to a named provider. The override, its reason and the admin who made it are written to the audit log.
- FR-20.9 Every assignment records what it matched on, so a patient asking why they saw a particular provider can be answered, and so an allocation can be audited under section 8.
- FR-20.10 The patient's preferred language and region are collected in the patient profile (FR-2.2) and are editable there. Region is added to the profile in version 1.2; without it FR-20.2 has nothing to match on.

---

## 5. Data Requirements

### 5.1 Main Entities

The database is twenty six tables. The authoritative definition is
`db/schema.dbml`, which renders as an entity relationship diagram at
dbdiagram.io and compiles to PostgreSQL DDL.

Accounts: patients, doctors, admins. Each row includes its current login and notification-device state. `doctors` holds providers on both registration forms.
Doctor onboarding: doctor_documents, doctor_availability.
Catalogue: specialties, concerns, regions.
Allocation: doctor_regions, which is the region pool an admin maintains per provider. Language pools need no table of their own: the languages a provider speaks are already on the provider row and the patient's preference is already on the patient row.
Consultation: consultations, consultation_participants, instant_consultancy, payments, clinical_records.
Files: patient_files, report_requests.
Follow-up: followup_pathways, checkin_responses, safety_alerts.
Other domains: clarification_cases, content_items, complaints.
Legal and platform: legal_documents, consents, data_deletion_requests, notifications, app_config, audit_log.

Several entities named in version 1.0 are no longer separate tables. They were
folded into the record they always belonged to, one per row, so that a fact has
exactly one home:

- Appointments and consultations are one table. `consultations.id` is the consultation ID required by FR-11.6.
- The slot hold, the follow-up assignment and the patient feedback all live on the consultation row.
- The video session is `consultation_participants`, one row per LiveKit connection rather than a pair of timestamps, because a party that loses signal mid-consult reconnects. The room itself is not stored - it is named from `consultations.id`, so one room per consultation holds by construction.
- Refunds and doctor payouts live on the payment row.
- Prescription lines, case summary, advice and therapy plan all live on the clinical record row.
- The NGO directory, self-help tools, education modules, blogs, caregiver guides and specialty red-flag references are all rows in `content_items`, separated by kind.
- Notification copy, crisis keywords, popular searches, fee percentages, GST rate and retention rules are all values in `app_config`.
- Doctor credentials are in `doctor_documents`, kept apart from patient files because the access rule is different.
- The registration form and prescribing eligibility are on the `specialties` row, not on the provider. A provider's specialty already decides both, and a copy on the provider record could disagree with it.
- What an assignment matched on is an `audit_log` entry, not a set of columns on the consultation. The consultation already names the provider; why that provider was chosen is a record of a decision, which is what the audit log is for.

### 5.2 Data Rules

- Every consultation record links booking, payment, video session metadata, documents, notes, prescription and case summary through one consultation ID.
- Case clarification records store a de-identified copy; direct identifiers are never written into the shared case.
- Consent records are versioned and time-stamped. A legal document version that anyone has accepted is never edited; a change is a new version row. A consent row points at the exact version accepted, so it can always be shown what a person agreed to.
- Configuration values, including fee percentages, GST rate, acceptance window, slot hold duration, crisis keywords, popular searches, mapping phrases, notification copy, question sets and retention rules, live in data, not code.
- Audit logs record who accessed or changed clinical and financial records, and when. The audit log carries no foreign key, so an entry outlives whatever it describes.
- No value is stored that can be calculated from other stored values. A stored copy is a second source of truth and the two drift apart. The exceptions are the billed amounts, which are frozen at checkout so that a later change to the fee percentage or GST rate cannot rewrite a past invoice, and the completion-gate flag on the doctor record, which is read on every instant routing decision.
- Where a fact could sit on more than one table, it sits on one. Records that are strictly one-per-consultation do not repeat the patient or the doctor; they are read through the consultation.

### 5.3 Retention

Medical record retention rules and patient data handling obligations are set by the client under applicable data protection law. The system stores clinical notes, prescriptions, files and appointment logs; it does not store video or audio of consultations.

---

## 6. Non-Functional Requirements

### 6.1 Security

- HTTPS everywhere. Encryption in transit and at rest.
- Role-scoped authorisation on every endpoint, checked server-side.
- Prescription retrieval is access-controlled; links are not publicly guessable.
- OTP attempts and login attempts are rate-limited.
- Payment status is trusted only from verified gateway webhooks.
- Secrets and API keys are held in the cloud environment, never in the app bundle.

### 6.2 Privacy

- A patient sees only their own records. A doctor sees only assigned patients and their own cases. An expert sees only shared, de-identified cases.
- Notifications never name a diagnosis.
- Consent is captured before teleconsultation.
- A clear privacy policy and a data-deletion request workflow are available in the app.
- No routine video recording in this release.

### 6.3 Safety

- Crisis language in symptom search interrupts booking and shows emergency guidance.
- Red-status check-ins show emergency guidance immediately and alert the doctor and admin.
- Emergency guidance is persistent and reachable from the Care Hub and the patient home screen.
- The app states that it is not for acute emergencies.

### 6.4 Performance and Reliability

- Search results, listings and dashboard screens load quickly on a normal mobile connection.
- Instant-consult requests route in near real time, with a defined acceptance window and automatic re-routing on timeout.
- Slot holds are released reliably on payment failure or timeout so slots are not lost.
- The system handles launch-scale traffic on the client's cloud account and can scale by adding resources.

### 6.5 Usability and Accessibility

- Simple, plain-language wording throughout.
- Role-specific navigation, so each user sees only relevant sections.
- Explainable AI results, with a stated reason for each match.
- Downloadable prescription PDF.
- Readable type sizes and clear contrast.

### 6.6 Maintainability and Configurability

- One mobile codebase for both roles and both platforms.
- The backend is split into domain modules inside one deployable service, so a module can later run as its own service without a rewrite.
- Content, question sets, mappings, crisis keywords, fee percentages, specialties, intake forms and prescription templates are all editable from the admin panel without an app release.
- API documentation, database schema and a deployment runbook are delivered.

### 6.7 Auditability

- Consultation IDs tie the full record together.
- Case clarification threads carry full status history.
- Quality dashboard exposes pending summaries, red flags and doctor reliability metrics.
- Payments, refunds and payouts are exportable as CSV.

---

## 7. Technology Stack

- Mobile apps: React Native. Two store listings, patient and doctor, over a shared internal package. Each app accepts only its own kind of account at sign-in.
- Admin web panel: React.js.
- Backend: NestJS on Node.js, served through Fastify, exposing a REST API with role-scoped authorisation on every endpoint. The code is organised as domain modules inside one deployable service.
- Database: PostgreSQL, accessed through Drizzle ORM. Twenty five tables. The schema is authored as DBML in `db/schema.dbml`, viewed as an entity relationship diagram at dbdiagram.io, and compiled to PostgreSQL DDL with `@dbml/cli`. Drizzle definitions are written to match that compiled output.
- Video conferencing: LiveKit. The backend issues room access tokens; the app joins the room through the LiveKit React Native SDK.
- Payments: Razorpay, covering UPI, cards, netbanking and wallets.
- AI search: hosted language model for query interpretation with a curated symptom-to-specialty mapping layer, so behaviour stays explainable and admin-controllable.
- Realtime: presence and request routing for Available Now.
- Push: Firebase Cloud Messaging and APNs.
- Infrastructure: deployed on the client's cloud account, HTTPS throughout, encrypted in transit and at rest.

---

## 8. Compliance and Responsibility

- The client is the healthcare service provider. The developer builds software that supports the client's clinical governance and compliance obligations, including consent capture, role-based access, de-identification, audit trails, mandatory documentation and encryption. The developer does not provide legal, medical or regulatory certification.
- Compliance with the Telemedicine Practice Guidelines and applicable medical council regulations rests with the client and its empanelled doctors.
- Verification of every doctor's qualification and medical registration before listing rests with the client.
- All clinical content, including follow-up questions, red-flag thresholds, education material, emergency guidance wording and the symptom-to-specialty mapping, must be reviewed and approved by a qualified clinician before launch.
- The AI search module assists navigation only. It does not screen, diagnose, triage clinical severity or influence treatment, and must not be presented to patients as doing so.
- Clinical decisions, diagnoses, prescriptions, case clarification responses and all patient communication remain the sole responsibility of the treating doctor.
- Medical record retention, patient data handling and obligations under applicable data protection law rest with the client.
- GST wording, tax treatment and invoice structure must be confirmed with the client's CA or legal advisor before launch. The developer builds the billing display and configuration to the confirmed structure.
- The product name and logo are adopted only after trademark clearance, domain and app-store availability checks, and legal review.

---

## 9. Deliverables and Schedule

Project start 5 August 2026. Duration 12 weeks. Target go-live 27 October 2026.

Deliverables:

- Complete Figma design files, including all seven doctor status states. Week 2, 18 August 2026.
- Shared backend API with role-based access control. Week 11, 20 October 2026.
- Live admin web panel. Week 11, 20 October 2026.
- Published app on the Apple App Store and Google Play Store, serving patient and doctor roles. Week 12, 27 October 2026.
- API documentation, database schema and deployment runbook. Week 12, 27 October 2026.
- Source code handover on full payment, in a private repository under the client's account. Week 12, 27 October 2026.

Timeline by week:

- Weeks 1 to 2, 5 to 18 August. Discovery and Figma design of patient, doctor and admin experiences, including all seven doctor status states and the Care Plan screen. Design sign-off. Accounts set up in the client's name for Play Store, App Store, Razorpay, LiveKit, AI provider and cloud. Milestone: designs signed off.
- Weeks 3 to 4, 19 August to 1 September. Backend and role-based authorisation; patient OTP sign-up and consent; admin-created doctor accounts; doctor profile and scheduled availability; admin panel foundation. Milestone: roles and availability working on staging.
- Weeks 5 to 6, 2 to 15 September. Service and concern selection; AI symptom and category search with mapping layer and crisis guardrail; doctor listing and profile; slot booking; Razorpay payment with the transparent bill breakdown. Milestone: Demo 1, search by symptom, pick a doctor, book and pay end to end.
- Weeks 7 to 8, 16 to 29 September. Video consultation on both sides; Available Now instant-consult engine and status machine; consultation room with documents and history; clinical notes, diagnosis, e-prescription and templates; mandatory case summary with the completion gate. Milestone: instant and scheduled consults complete on staging.
- Week 9, 30 September to 6 October. Pathway-wise seven-day follow-up; green, amber and red status; red-flag detection, emergency guidance and doctor or admin alerting; follow-up booking. Milestone: Demo 2, instant consult through prescription, case summary and a red-flag alert.
- Week 10, 7 to 13 October. Care Hub: self-help tools, education library, blogs, caregiver guide, NGO directory and doctor-recommended resources. Case clarification module with de-identification and expert role. Feedback and complaints. Milestone: Care Hub and case clarification usable.
- Week 11, 14 to 20 October. Admin web panel completed: doctor approval, specialty management, payments and refunds, clinical governance, quality dashboard, content management. Privacy controls. Functional testing across devices. Milestone: Demo 3, full platform on staging.
- Week 12, 21 to 27 October. UAT with the client's team and fixes; App Store and Play Store submissions; production deployment; documentation and knowledge transfer. Milestone: go-live.

Schedule assumptions: design and demo feedback within three business days, and no major scope additions mid-build. Store submissions are made in Week 12; approval dates belong to Apple and Google, and health apps commonly attract extra review scrutiny. The admin panel, backend and documentation are delivered on the dates shown regardless of store review.

---

## 10. Acceptance Criteria

The release is accepted when:

- A patient can sign up by OTP, give consent, search by symptom in plain words, see explained matches, book and pay, and complete a video consultation.
- A doctor can go Available Now, receive and accept an instant request, run the consult, write notes and a prescription, and submit a case summary, with the completion gate blocking a new instant request until documentation is done.
- All seven doctor status states behave as specified, including timeout, decline and re-routing.
- A crisis-language query interrupts booking and shows emergency guidance.
- Seven-day check-ins run on the assigned pathway, and a red response shows emergency guidance and raises alerts to the doctor and admin.
- A case can be posted for clarification with direct identifiers stripped, visible only to the assigned expert, and it is not shown to the patient.
- The patient bill and doctor payout view show the full breakdown, with the doctor receiving the full consultation fee.
- A patient books without ever seeing a choice of provider, and the provider assigned speaks their preferred language and is free for the full consultation duration at that time.
- An admin can put providers into language and region pools, see who is assignable for a given service, language, region and time, and override an assignment with the reason recorded.
- A provider can be registered on either form, doctor or non-doctor, and the credentials demanded and the prescribing rights granted follow from the specialty.
- The admin panel can approve providers, add a specialty of either registration form with its intake form and prescription template, add a region, edit follow-up questions and crisis keywords, process a refund, and export transactions, all without an app release.
- Functional testing across devices is complete and one full round of UAT is signed off.

---

## 11. Out of Scope for This Release

- Third-party running costs: LiveKit usage, AI model usage, payment gateway MDR, Slide OTP charges, and cloud hosting, estimated at 3,000 to 6,000 rupees per month at launch scale. The Slide figure is an estimate until the client's plan is confirmed.
- Apple Developer and Google Play Console account fees.
- All clinical and educational content authoring and clinical review.
- Legal copy: privacy policy, terms of use, teleconsultation consent, refund and reconsult policy.
- Trademark clearance, name and logo legal review, GST and tax structuring.
- Verification of doctors' qualifications and medical registration.
- Community peer groups and open discussion forums, excluded by design.
- Video or audio recording of consultations.
- Reusable prescription and therapy-plan templates. Deferred from FR-9.6. Doctors write each prescription and plan directly at launch.
- Server-side logging of symptom search queries. Recent searches are held on the patient device; no query analytics is collected in this release.
- Multiple specialties per doctor. Each doctor is listed under one specialty, which is what decides their prescribing eligibility.
- Patient-led doctor selection. Removed in version 1.2, not deferred: the patient chooses a service and the system assigns the provider. A doctor directory, doctor browse, doctor filters and sort-by-fee are all out of the patient application.
- Multiple regions per patient, and provider travel or in-person visits. A patient has one region and every consultation is remote.
- App lock and PIN, restricted medicine formulary, second opinion service, patient timeline health record, therapy packages.
- Lab booking, pharmacy referral, chronic disease pathways, corporate and family plans, multilingual app, advanced analytics.
- Automated doctor payouts; payouts are reported in the dashboard and paid by the client.
- Marketing, App Store Optimization and paid user acquisition.
- Maintenance beyond the three-month post-launch window, available under a separate AMC.

---

## 12. Future Roadmap

- Phase 1.5: reusable prescription and therapy-plan templates, multiple specialties per doctor, server-side search analytics, restricted medicine formulary with interaction checks, expanded self-help and education library, app lock and PIN.
- Phase 2: additional specialties activated with their forms and templates, second opinion service, patient timeline health record, therapy packages, expanded report and photo review.
- Phase 3: partner lab booking, pharmacy referral, chronic disease pathways, corporate and family plans, multilingual app, advanced analytics.
- AI extensions: consultation summariser drafting notes from the call for doctor approval, AI-assisted prescription drafting with dosage checks, and predictive relapse alerting from follow-up trends.

---

## 13. Support and Change Control

- Three months complimentary maintenance after production go-live: bug and crash fixes, uptime monitoring, minor content corrections across the app and admin panel.
- Up to two rounds of design revisions and two rounds of content and layout revisions per application area.
- Work outside the agreed scope is handled as a written Change Request with agreed cost and timeline, approved by both parties before work begins.
- New features and screens during the maintenance window are handled by Change Request, not as maintenance.

---

## 14. Revision History

### Version 1.2, 1 September 2026

Client instructions of 1 September 2026. Two of the four change requirements
already approved in version 1.1, so they are recorded here as supersessions
rather than as additions.

**The patient no longer chooses their doctor**

- FR-4.2 is now the opposite of what version 1.1 said. The system assigns the provider from the specialty needed and the patient's preferred language. FR-4.1 to FR-4.4 are rewritten and a new FR-4.5 carries the one-specialty rule that used to sit inside FR-4.3.
- The doctor directory, doctor browse, filter and sort-by-fee leave the patient application entirely. Section 11 records this as removed, not deferred.
- FR-5.1 and FR-5.4 change with it: symptom search returns specialties and concerns, never a shortlist of named providers. Its output feeds assignment.
- Section 4.20 is new and holds the allocation rules in one place.

**Allocation is configured by the admin panel**

- FR-18.9 gives the panel the language and region pools, the allocation policy, an assignability view showing available duration per provider for a chosen time, and a per-consultation override with the reason recorded.
- FR-10.7 makes available *duration* part of assignment. A provider free at 3pm but free for only ten minutes is not assignable to a thirty-minute consultation.
- Region is new to the product. It exists nowhere in version 1.1, in the database, or in the module plan. FR-19.8 makes regions admin-configurable, FR-20.10 adds region to the patient profile, and `regions` and `doctor_regions` are new tables in section 5.1.

**Providers register on one of two forms**

- Section 2.2 replaces the single Doctor user class with Provider, on two registration forms: doctor, and non-doctor healthcare provider.
- FR-19.7 puts the form on the `specialties` row rather than on the provider record. The specialty already decides prescribing eligibility and the required credential list, and a second copy on the provider could disagree with it.
- This is a description of what the platform already does, made explicit. Version 1.1 already covered psychologists, therapists and counsellors under the Doctor class and already had per-specialty prescribing. What is new is that the two are named, registered differently and reported separately.

**Four decisions taken, 1 September 2026**

Each of these fell out of the change rather than being part of it, and each was
put to the client and settled the same day.

1. **The consultation fee moves to the specialty.** FR-7.8. A per-provider fee cannot survive a patient who does not choose the provider: the price is quoted before the provider is known. `doctors.consultation_fee_inr` stops being what the patient is charged and becomes what that provider is paid (FR-7.9).
2. **Region is a preference, not a hard rule.** FR-20.5. Assignment prefers the patient's region and relaxes it, recording that it did, rather than refusing the booking. Language is never relaxed.
3. **A region is a state or province.** FR-20.11. Regions are rows, so the granularity can be changed later without a release.
4. **A patient may decline an assigned provider, up to a configured limit**, giving a reason. FR-4.4. Without it a patient with a reasonable objection could only abandon the booking; unlimited, it would be provider shopping by another name.

**One decision still open**

- **The word "doctor".** The `doctors` table, the provider application and its store listing now all hold non-doctor providers too. Renaming reaches the database, both applications and the store listings, so it is not a change to make halfway through a build. The recommendation is to keep the internal name and use "provider", or the client's preferred term, in every patient-facing and provider-facing string. Needed before UI copy is written, and it blocks no data model work.

**Not changed**

- Allocation is a scheduling and routing decision, not a clinical one. It selects who is available and appropriate to take the consultation; the treating provider's clinical responsibility under section 8 is untouched by it.
- The seven provider states, the completion gate, the instant acceptance window and re-routing all stand. Re-routing now picks the next provider by the same rules as any first assignment.
- Nothing here changes consent, audit, privacy or the expert-opinion visibility rules.

### Version 1.1, 27 August 2026

Revised to match the approved database design. No feature was added. Two were
deferred and are listed in section 11.

**User model**

- Three account kinds, each in its own table: patient, doctor, admin. There is no shared user record and no role column; the table an account lives in is its role.
- Expert doctor is no longer a role. It is an admin-granted level on the doctor record. Visibility of a case still requires that case to be assigned to that expert.
- Care coordinator is no longer a role. It is an admin permission level.
- Service account is removed. The payment webhook is authenticated by HMAC signature on the raw body, with no identity.
- Doctor registration is stated explicitly: admin creates the account, doctor uploads credentials, an admin approves each credential separately, then approves the doctor, then lists them. A doctor is bookable only when verified and listed.

**Data requirements, section 5**

- Section 5.1 now names the actual twenty five tables and records which version 1.0 entities were folded into the row they belong to.
- Section 5.2 adds the rule that no calculated value is stored, with the billing snapshot and the completion-gate flag as the two stated exceptions.
- Section 5.2 adds the rule that a legal document version accepted by anyone is never edited.

**Scope**

- FR-9.6, reusable prescription templates, deferred to Phase 1.5.
- FR-5.11, server-side query logging removed; recent searches move to the device. The admin-curated popular searches list is unchanged.
- Multiple specialties per doctor deferred to Phase 1.5.

**Added**

- FR-13.8. The treating doctor may add patient-specific check-in questions on top of the assigned pathway. FR-9.7 already gave the doctor the pathway choice and the review date, but version 1.0 gave no way to tailor the questions themselves. Doctor-added questions never trigger safety alerts.

**Identity provider**

- Slide is named as the OTP provider in sections 2.1, 2.5 and 3.3. OTP generation, expiry and attempt state now belong to Slide; the platform keeps only the fact and time of a successful verification.
- FR-1.9 restated. Rate limiting stays the platform's obligation and is enforced from the audit log, in addition to whatever Slide applies. **Slide's own limits must be confirmed in writing and recorded in section 3.3 before build.**
- FR-1.10 added. Optional two-factor authentication for admin accounts, using a Slide OTP challenge after password verification.

**Corrected contradictions**

- FR-4.3 said "specialties" while section 11 lists multiple specialties per doctor as out of scope. FR-4.3 now reads singular and points at section 11.
- FR-19.3 said red flags are specialty-wise, but the runtime rules that turn a check-in red are condition-wise, held with the follow-up pathway. FR-19.3 now describes both axes and **asks the client to confirm the split matches clinical intent.**

**Renamed

- The instant-consult routing table is `instant_consultancy`. It was `instant_offers` in the first draft of the database design.

**Still open, needed before Week 3**

- Confirmation that the patient and doctor applications ship as two store listings rather than one. Sections 2.1, 2.4 and 7 are written on that basis, following the Module Plan, but the client has not confirmed it. It affects store accounts, push credentials and release scheduling.
- FR-9 report requests are retained in scope. They were reviewed for removal and kept because they are a written requirement.

**Not yet verified**

- The compiled PostgreSQL DDL has not been executed against a live database. The statements that DBML cannot express - partial unique indexes, CHECK constraints, composite foreign keys and GIN indexes, including the index that prevents double booking and the checks that keep account columns consistent - must be added by hand in the first migration. They are listed in `db/README.md`.
