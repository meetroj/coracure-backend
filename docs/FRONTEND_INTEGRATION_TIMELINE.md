# Frontend Development and Integration Timeline

Project: Coracure  
Document date: 8 September 2026  
Planned duration: 8 working days  
Team:
- Engineer 1: Frontend
- Engineer 2: Integration and Frontend support

## 1. Purpose

This document is for tracking the frontend development and integration progress module-wise. The frontend work is planned for about 5 working days, built in parallel with integration work that is expected to take about 6 to 8 working days.

Both engineers should use Claude Code extensively for implementation, UI iteration, API integration, debugging, test creation, refactoring, and fixing issues found during daily verification.

## 2. Working Assumptions

- The backend API modules already exist or are being stabilized in parallel.
- Frontend and integration work should run simultaneously, not one after the other.
- The first 5 days focus on building the usable frontend flows.
- Days 6 to 8 focus on integration completion, bug fixing, test coverage, and final stabilization.
- Every module should be considered complete only after UI, API integration, role handling, validation, error states, and basic tests are verified.
- Daily progress should be tracked by completed screens, connected APIs, tested flows, and unresolved bugs.

## 3. Engineer Ownership

| Owner | Primary Responsibility | Secondary Responsibility |
| --- | --- | --- |
| Engineer 1 | Frontend screens, layout, routing, forms, dashboards, responsive UI, UI states | Frontend bug fixes, UI tests, API contract feedback |
| Engineer 2 | API integration, auth/session wiring, data flow, endpoint testing, integration bugs | Support frontend implementation where needed |

## 4. Module Groups

The backend contains 21 modules. For frontend and integration tracking, they should be grouped into practical product areas.

| Product Area | Backend Modules | Main Frontend Surface |
| --- | --- | --- |
| Platform and Auth | M-01, M-02 | App shell, login, OTP, admin login, role-based navigation |
| Legal and Profile | M-03, M-04 | Consent screens, legal pages, patient profile |
| Doctor and Admin Setup | M-05, M-06 | Admin doctor management, verification, specialties, concerns, regions, allocation settings |
| Search and Scheduling | M-07, M-09 | Search/concern mapping, availability, slot selection |
| Booking and Payments | M-11, M-12 | Booking flow, payment flow, billing status |
| Instant and Video Consult | M-13, M-14 | Doctor presence, instant consult request, video room entry and consult controls |
| Records and Files | M-10, M-15 | Upload files, view records, prescriptions, therapy/advice plans |
| Follow-Up and Support | M-16, M-17, M-18, M-19 | Care plans, check-ins, clarification threads, care hub, complaints, feedback |
| Governance and Compliance | M-08, M-20, M-21 | Notifications, admin governance dashboard, audit/compliance/data-rights screens |

## 5. Overall Timeline

| Day | Frontend Engineer Target | Integration Engineer Target | Expected Progress |
| --- | --- | --- | --- |
| Day 1 | App shell, routing, layout system, auth screens, role-based navigation | API contract review, environment setup, auth token/session integration | Project structure ready, login flows started, API client prepared |
| Day 2 | Patient profile, consent/legal, catalogue/search screens | Connect auth, profile, consent, catalogue, search endpoints | User can sign in, complete profile, view legal content, search concerns |
| Day 3 | Scheduling, booking, payment UI, admin doctor/catalogue screens | Connect scheduling, booking, payment, doctor, catalogue endpoints | Main booking journey works with real API responses |
| Day 4 | Instant consult, video consult, files, clinical records screens | Connect instant, video token/room, file upload/download, clinical records endpoints | Consultation-related flows usable end to end |
| Day 5 | Follow-up, care hub, clarification, support, notifications, governance screens | Connect remaining modules, handle edge cases and error states | Frontend feature build complete; all major modules visible |
| Day 6 | UI bug fixing, responsive fixes, loading/empty/error states | Integration bug fixing, failing endpoint fixes, auth/role issue cleanup | Most module flows stable; first full regression pass complete |
| Day 7 | Test fixes, validation polish, final UX pass | Integration tests, API contract fixes, data consistency checks | Critical and high bugs closed; release candidate build prepared |
| Day 8 | Final acceptance fixes and documentation updates | Final end-to-end verification and deployment readiness checks | Handoff-ready frontend and integration build |

## 6. Detailed Daily Breakdown

### Day 1: Foundation, Auth, and App Structure

Frontend tasks:
- [ ] Create frontend app structure and route groups for patient, doctor, and admin surfaces.
- [ ] Build shared layout, navigation, protected route handling, and responsive shell.
- [ ] Build patient OTP login/sign-up screen.
- [ ] Build doctor/admin login screens.
- [ ] Add reusable UI states: loading, empty, error, success, disabled, unauthorized.

Integration tasks:
- [ ] Review backend API contracts from available controllers and DTOs.
- [ ] Set up API client, base URL config, token storage, request interceptors, and response error handling.
- [ ] Connect M-02 auth endpoints.
- [ ] Verify role-scoped login behavior for patient, doctor, and admin.
- [ ] Create first smoke test checklist for login and route access.

Progress target:
- [ ] Each role can reach its correct shell after login.
- [ ] Unauthorized users are redirected or blocked correctly.
- [ ] API errors are displayed in a readable way.

### Day 2: Legal, Profile, Catalogue, and Search

Frontend tasks:
- [ ] Build consent capture flow.
- [ ] Build legal document viewer for terms, privacy, refund, and teleconsultation consent.
- [ ] Build patient profile create/edit/view screens.
- [ ] Build concern search and specialty recommendation UI.
- [ ] Build catalogue display components for specialties, concerns, languages, and regions.

Integration tasks:
- [ ] Connect M-03 consent and legal endpoints.
- [ ] Connect M-04 patient profile endpoints.
- [ ] Connect M-06 catalogue endpoints.
- [ ] Connect M-09 search/concern mapping endpoints.
- [ ] Validate required fields and backend validation messages.

Progress target:
- [ ] Patient can complete consent and profile.
- [ ] Patient can search by concern and see suggested specialty/concern.
- [ ] Catalogue values come from backend, not hardcoded frontend data.

### Day 3: Doctor/Admin Setup, Scheduling, Booking, and Payments

Frontend tasks:
- [ ] Build admin doctor list, create/edit doctor, credential review, approve/reject, list/suspend screens.
- [ ] Build admin specialty, concern, region, and allocation settings screens.
- [ ] Build doctor availability setup screens.
- [ ] Build patient slot selection and booking confirmation screens.
- [ ] Build payment initiation, success, failure, and billing status screens.

Integration tasks:
- [ ] Connect M-05 doctor registry and verification endpoints.
- [ ] Connect M-06 admin catalogue/allocation settings endpoints.
- [ ] Connect M-07 availability and scheduling endpoints.
- [ ] Connect M-11 booking endpoints.
- [ ] Connect M-12 payment and billing endpoints.

Progress target:
- [ ] Admin can prepare doctors and catalogue data needed for booking.
- [ ] Patient can choose available time and create a booking.
- [ ] Payment status is reflected correctly in the frontend.

### Day 4: Instant Consult, Video, Files, and Clinical Records

Frontend tasks:
- [ ] Build doctor presence and availability toggle UI.
- [ ] Build patient instant consult request flow.
- [ ] Build doctor instant consult accept/reject UI.
- [ ] Build video consultation entry screen and consultation room shell.
- [ ] Build patient file upload/list/download UI.
- [ ] Build clinical notes, prescription, advice, and therapy plan views.

Integration tasks:
- [ ] Connect M-13 presence and instant consult endpoints.
- [ ] Connect M-14 video session/token/room endpoints.
- [ ] Connect M-10 file upload, report request, and file access endpoints.
- [ ] Connect M-15 clinical record endpoints.
- [ ] Test permissions for patient, assigned doctor, and admin visibility.

Progress target:
- [ ] Instant consult can be requested and accepted.
- [ ] Video session can be entered with correct role permissions.
- [ ] Patient files and clinical records are accessible only to allowed users.

### Day 5: Follow-Up, Support, Notifications, Governance, and Compliance

Frontend tasks:
- [ ] Build care plan and follow-up check-in screens.
- [ ] Build patient safety alert and escalation display where applicable.
- [ ] Build clarification thread UI.
- [ ] Build care hub view.
- [ ] Build feedback and complaint screens.
- [ ] Build notification center.
- [ ] Build admin governance, audit, compliance, and data-rights screens.

Integration tasks:
- [ ] Connect M-16 follow-up and safety endpoints.
- [ ] Connect M-17 clarification endpoints.
- [ ] Connect M-18 care hub/content endpoints.
- [ ] Connect M-19 feedback and complaints endpoints.
- [ ] Connect M-08 notifications endpoints.
- [ ] Connect M-20 governance and M-21 compliance endpoints.

Progress target:
- [ ] All frontend modules have at least one connected happy path.
- [ ] All high-priority user journeys are visible and usable.
- [ ] Known bugs are logged with owner, severity, and target fix day.

### Day 6: Integration Stabilization and Bug Fixing

Frontend tasks:
- [ ] Fix responsive layout issues across mobile, tablet, and desktop.
- [ ] Add missing loading, empty, validation, permission, and failure states.
- [ ] Fix form validation and field-level error display.
- [ ] Remove hardcoded mock data from completed modules.
- [ ] Polish navigation between patient, doctor, and admin flows.

Integration tasks:
- [ ] Run full integration pass module by module.
- [ ] Fix auth token refresh/session expiry issues.
- [ ] Fix request/response mapping issues between frontend and backend DTOs.
- [ ] Verify file uploads, payment callbacks/status refresh, video tokens, and notification reads.
- [ ] Add or update integration tests for critical flows.

Progress target:
- [ ] Critical bugs are fixed.
- [ ] High bugs have owners and estimated completion.
- [ ] One complete patient journey and one complete doctor/admin journey pass end to end.

### Day 7: Testing, Regression, and Release Candidate

Frontend tasks:
- [ ] Add focused component or page tests for critical screens.
- [ ] Perform regression pass for auth, booking, payment, video, files, records, and follow-up.
- [ ] Fix visual polish issues and inconsistent UI states.
- [ ] Verify accessibility basics: labels, keyboard access, focus states, contrast, readable error messages.

Integration tasks:
- [ ] Run backend unit/integration/e2e tests relevant to connected modules.
- [ ] Test role and ownership permissions across patient, doctor, and admin.
- [ ] Validate database-backed flows with realistic seeded data.
- [ ] Verify audit/compliance events for sensitive actions.
- [ ] Prepare release candidate notes with remaining known issues.

Progress target:
- [ ] No open critical bugs.
- [ ] High bugs are either fixed or explicitly accepted for later.
- [ ] Release candidate build is available for stakeholder review.

### Day 8: Final Fixes and Handoff

Frontend tasks:
- [ ] Close final accepted UI and usability issues.
- [ ] Verify production build.
- [ ] Update frontend run/test notes.
- [ ] Prepare screen/module completion summary.

Integration tasks:
- [ ] Close final integration defects.
- [ ] Verify environment configuration.
- [ ] Confirm API base URLs, storage, payments, video, notifications, and auth settings.
- [ ] Prepare final integration handoff notes.

Progress target:
- [ ] Handoff-ready build.
- [ ] All tracked modules have status, owner, and final remarks.
- [ ] Remaining issues are documented with severity and next action.

## 7. Module-Wise Progress Tracker

| Module | Frontend Status | Integration Status | Tests/Bug Fixing Status | Owner Notes |
| --- | --- | --- | --- | --- |
| M-01 Platform Foundation | Not started | Not started | Not started | App config, errors, audit expectations |
| M-02 Identity and Access | Not started | Not started | Not started | Patient OTP, doctor login, admin login, role guards |
| M-03 Consent and Legal | Not started | Not started | Not started | Consent blocking rules, legal document display |
| M-04 Patient Profile | Not started | Not started | Not started | Profile forms and ownership checks |
| M-05 Doctor Registry and Verification | Not started | Not started | Not started | Admin doctor management and credential review |
| M-06 Catalogue and Allocation | Not started | Not started | Not started | Specialties, concerns, regions, allocation policy |
| M-07 Availability and Scheduling | Not started | Not started | Not started | Doctor availability, slot lookup, conflict handling |
| M-08 Notifications | Not started | Not started | Not started | Notification center and read states |
| M-09 Search and Concern Mapping | Not started | Not started | Not started | Patient search and specialty suggestion |
| M-10 Documents and File Storage | Not started | Not started | Not started | Upload, download, report requests |
| M-11 Booking | Not started | Not started | Not started | Booking creation, confirmation, decline/reschedule handling |
| M-12 Payments and Billing | Not started | Not started | Not started | Payment start, success, failure, billing status |
| M-13 Presence and Instant Consult | Not started | Not started | Not started | Presence toggle, instant request, accept/reject |
| M-14 Video Consultation | Not started | Not started | Not started | Room entry, tokens, consult state |
| M-15 Clinical Records | Not started | Not started | Not started | Notes, prescriptions, therapy/advice plans |
| M-16 Follow-Up and Patient Safety | Not started | Not started | Not started | Check-ins, alerts, care plan follow-up |
| M-17 Case Clarification | Not started | Not started | Not started | Doctor/admin clarification threads |
| M-18 Care Hub | Not started | Not started | Not started | Patient education/content surfaces |
| M-19 Feedback and Complaints | Not started | Not started | Not started | Feedback forms, complaint threads |
| M-20 Governance and Quality | Not started | Not started | Not started | Admin quality/governance dashboard |
| M-21 Audit, Compliance and Data Rights | Not started | Not started | Not started | Data access, deletion requests, compliance views |

Status values to use:
- Not started
- In progress
- Blocked
- In review
- Passed
- Needs fix
- Done

## 8. Daily Standup Tracking Template

Use this section once per day.

### Date:

Frontend Engineer:
- Completed:
- In progress:
- Blocked:
- Bugs found:
- Bugs fixed:
- Claude Code used for:
- Tomorrow target:

Integration Engineer:
- Completed:
- In progress:
- Blocked:
- Bugs found:
- Bugs fixed:
- Claude Code used for:
- Tomorrow target:

Module status changed today:
- 

Risks:
- 

Decisions needed:
- 

## 9. Bug Tracking Template

| Bug ID | Module | Severity | Found By | Owner | Status | Target Fix Day | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BUG-001 |  | Critical/High/Medium/Low |  |  | Open/In progress/Fixed/Retest/Closed |  |  |

Severity guide:
- Critical: blocks login, booking, payment, consult, security, or production build.
- High: major user journey broken but workaround exists.
- Medium: visible issue or edge case that should be fixed before handoff.
- Low: polish issue, copy issue, minor layout problem.

## 10. Test Checklist

Auth and roles:
- [ ] Patient can sign up/login only through patient flow.
- [ ] Doctor can login only through doctor flow.
- [ ] Admin can login only through admin flow.
- [ ] Wrong-role access is blocked.
- [ ] Expired or invalid session is handled cleanly.

Patient journey:
- [ ] Consent completed.
- [ ] Profile completed.
- [ ] Concern search works.
- [ ] Slot/consult selection works.
- [ ] Booking is created.
- [ ] Payment status is shown.
- [ ] Video/instant consult entry works where applicable.
- [ ] Files and clinical records are visible after consult.
- [ ] Follow-up/check-in flow works.
- [ ] Feedback or complaint can be submitted.

Doctor journey:
- [ ] Doctor profile/verification state is displayed correctly.
- [ ] Availability can be managed.
- [ ] Instant request can be accepted/rejected.
- [ ] Consultation details can be opened.
- [ ] Clinical notes or care plan can be created.
- [ ] Report requests and patient files work.

Admin journey:
- [ ] Doctor account can be created and managed.
- [ ] Credentials can be approved/rejected.
- [ ] Specialties, concerns, regions, and allocation settings can be managed.
- [ ] Payments, bookings, complaints, governance, and compliance views load.
- [ ] Audit/compliance-sensitive actions are visible where required.

Technical checks:
- [ ] Frontend production build passes.
- [ ] Type checking passes.
- [ ] Linting passes.
- [ ] Critical frontend tests pass.
- [ ] Critical backend/integration tests pass.
- [ ] No mock data remains in integrated modules.
- [ ] Environment variables are documented.

## 11. Claude Code Usage Expectations

Both engineers should use Claude Code for:
- Reading backend controllers, DTOs, services, and tests before wiring frontend calls.
- Generating frontend API clients and request/response types.
- Building screens iteratively from module requirements.
- Fixing TypeScript, lint, build, and test failures.
- Creating focused tests for risky flows.
- Debugging integration mismatches between frontend payloads and backend DTOs.
- Refactoring duplicated frontend logic after the first working implementation.
- Producing daily change summaries and unresolved risk notes.

Claude Code should not replace manual verification. Each engineer must still run the app, test real user journeys, and confirm that the UI behavior matches the project requirements.

## 12. Completion Criteria

Frontend work is complete when:
- [ ] All required screens for patient, doctor, and admin are implemented.
- [ ] All screens are responsive and usable.
- [ ] Loading, empty, error, validation, unauthorized, and success states are handled.
- [ ] No completed module depends on mock data.
- [ ] Production build passes.

Integration work is complete when:
- [ ] All required backend modules are connected to the frontend where applicable.
- [ ] Auth, role, and ownership checks behave correctly in the UI.
- [ ] Booking, payment, instant/video consult, files, records, follow-up, support, and compliance flows are verified.
- [ ] Critical and high bugs are closed or formally accepted.
- [ ] Final test checklist is completed.

Final handoff is complete when:
- [ ] Day 8 verification is complete.
- [ ] Module-wise tracker is updated.
- [ ] Open bugs are documented with severity and owner.
- [ ] Run, test, and environment notes are updated.
