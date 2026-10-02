import * as z from 'zod';

/** Which account table the recipient lives in. Admins are read in the panel. */
export type RecipientKind = 'patient' | 'doctor' | 'admin';

/**
 * The codes the platform knows how to raise.
 *
 * `notifications.template_code` is a VARCHAR rather than an enum precisely so a
 * new code needs no migration - but a caller still gets a compile error for a
 * typo, because every raise goes through this union. Adding one means adding a
 * definition below and nothing else.
 */
export const NOTIFICATION_CODES = [
  // -- Patient (FR-16.1) ------------------------------------------------------
  'booking_confirmed',
  'consult_reminder',
  'doctor_joined',
  'prescription_ready',
  'checkin_due',
  'report_requested',
  // -- Provider (FR-16.4) -----------------------------------------------------
  'instant_request',
  'red_flag_alert',
  'amber_alert',
  'missed_checkin',
  'pending_documentation',
  'report_uploaded',
  'document_rejected',
  'doctor_approved',
  'doctor_rejected',
  'doctor_application_submitted',
  'case_assigned',
  'case_reply',
] as const;

export type NotificationCode = (typeof NOTIFICATION_CODES)[number];

/**
 * What a template may interpolate.
 *
 * *** THIS LIST IS HALF OF FR-16.2. *** A notification never names a diagnosis,
 * and the surest way to keep one out of the copy is to give the copy no way to
 * ask for one. There is no `diagnosis`, no `riskLevel`, no `concern` and no
 * `symptom` here, and an admin editing a template can only use what is listed:
 * anything else is refused when they save it.
 *
 * What is left is logistics - who, when, and what to do next - which is all a
 * notification is for.
 */
export const PLACEHOLDERS = [
  'patientName',
  'doctorName',
  /** The SERVICE, e.g. "Psychiatry". Never the concern behind the booking. */
  'serviceName',
  /** Already formatted for the reader by the caller; this module does no dates. */
  'consultationTime',
  /** "in 30 minutes", "tomorrow" - relative wording for a reminder. */
  'timeUntil',
  /** What a provider asked the patient to upload, e.g. "a recent blood report". */
  'requestedItem',
  /** Which day of a follow-up plan a check-in belongs to. */
  'checkinDay',
  /** Why a credential was rejected, written by the reviewing admin. */
  'rejectionReason',
  /** A count, for the admin queue alerts. */
  'count',
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface TemplateDefinition {
  code: NotificationCode;
  /** Who this code may be addressed to. A raise to anyone else is refused. */
  audience: RecipientKind[];
  /** The subset of `PLACEHOLDERS` this template's copy may use. */
  placeholders: Placeholder[];
  title: string;
  body: string;
  /** Shown beside the copy in the admin panel, so an editor knows what it is for. */
  description: string;
}

/**
 * The copy that ships. It is a DEFAULT, not the truth: on first boot these are
 * seeded into `app_config` under `notifications.templates`, and from then on the
 * admin panel owns them (FR-16.3). Editing this file changes what a brand new
 * database starts with and nothing else.
 */
export const NOTIFICATION_TEMPLATES: TemplateDefinition[] = [
  {
    code: 'booking_confirmed',
    audience: ['patient'],
    placeholders: ['doctorName', 'consultationTime'],
    title: 'Your consultation is confirmed',
    body: 'Your consultation with {{doctorName}} is confirmed for {{consultationTime}}.',
    description: 'Sent once payment succeeds and the slot is held for good (FR-16.1).',
  },
  {
    code: 'consult_reminder',
    audience: ['patient'],
    placeholders: ['doctorName', 'consultationTime', 'timeUntil'],
    title: 'Your consultation is {{timeUntil}}',
    body: 'Your consultation with {{doctorName}} starts {{timeUntil}}, at {{consultationTime}}. Please join a few minutes early.',
    description: 'The reminder before a scheduled consultation (FR-16.1).',
  },
  {
    code: 'doctor_joined',
    audience: ['patient'],
    placeholders: ['doctorName'],
    title: 'Your consultation is ready',
    body: '{{doctorName}} has joined. Open the app to start your consultation.',
    description: 'The provider is in the room and the patient is not yet (FR-16.1).',
  },
  {
    code: 'prescription_ready',
    audience: ['patient'],
    placeholders: ['doctorName'],
    title: 'Your prescription is ready',
    body: '{{doctorName}} has finished your notes. Open the app to read them.',
    description:
      'Deliberately says "notes" rather than naming what was prescribed: a lock-screen preview is read by whoever is holding the phone (FR-16.2).',
  },
  {
    code: 'checkin_due',
    audience: ['patient'],
    placeholders: ['checkinDay'],
    title: 'Your check-in is due',
    body: 'Your day {{checkinDay}} check-in is ready. It takes a minute.',
    description: 'The daily follow-up prompt (FR-16.1).',
  },
  {
    code: 'report_requested',
    audience: ['patient'],
    placeholders: ['doctorName', 'requestedItem'],
    title: 'Your provider has asked for a document',
    body: '{{doctorName}} has asked for {{requestedItem}}. You can upload it in the app.',
    description: 'A provider raised a report request against the consultation (FR-16.1).',
  },

  {
    code: 'instant_request',
    audience: ['doctor'],
    placeholders: ['serviceName'],
    title: 'New instant consultation request',
    body: 'A patient is waiting for a {{serviceName}} consultation. Open the app to accept.',
    description: 'An instant request routed to this provider (FR-16.4).',
  },
  {
    code: 'red_flag_alert',
    audience: ['doctor', 'admin'],
    placeholders: ['patientName'],
    title: 'Urgent: a check-in needs review',
    body: 'A check-in from {{patientName}} needs your attention now. Open the app to review it.',
    description:
      'The safety alert (FR-16.4, SRS 6.3). Says a review is needed and never what was answered - the copy must carry urgency without carrying clinical content.',
  },
  {
    code: 'amber_alert',
    audience: ['doctor', 'admin'],
    placeholders: ['patientName'],
    title: 'A check-in needs review',
    body: 'A check-in from {{patientName}} needs review today.',
    description: 'The lower-severity safety alert (FR-16.4).',
  },
  {
    code: 'missed_checkin',
    audience: ['doctor', 'admin'],
    placeholders: ['patientName', 'count'],
    title: 'Missed check-ins',
    body: '{{patientName}} has missed {{count}} check-ins.',
    description: 'Follow-up adherence, for the provider and the care coordinator.',
  },
  {
    code: 'pending_documentation',
    audience: ['doctor'],
    placeholders: ['patientName'],
    title: 'Documentation outstanding',
    body: 'Your notes for the consultation with {{patientName}} are not finished. New instant requests are paused until they are.',
    description: 'The FR-10.5 completion gate, told to the provider it is holding (FR-16.4).',
  },
  {
    code: 'report_uploaded',
    audience: ['doctor'],
    placeholders: ['patientName'],
    title: 'A patient has uploaded a document',
    body: '{{patientName}} has uploaded the document you asked for.',
    description: 'The other half of `report_requested` (FR-16.4).',
  },
  {
    code: 'document_rejected',
    audience: ['doctor'],
    placeholders: ['rejectionReason'],
    title: 'A credential needs re-uploading',
    body: 'One of your credentials was not accepted: {{rejectionReason}}. You can upload a replacement in the app.',
    description: 'M-05 verification turned a document down, with the reviewing admin’s reason.',
  },
  {
    code: 'doctor_approved',
    audience: ['doctor'],
    placeholders: [],
    title: 'Your account is approved',
    body: 'Your account has been verified. You can now set your availability and take consultations.',
    description: 'M-05 verification completed. The moment the provider experience opens.',
  },
  {
    code: 'doctor_rejected',
    audience: ['doctor'],
    placeholders: ['rejectionReason'],
    title: 'Your application needs changes',
    body: 'Your application was not approved: {{rejectionReason}}. Open the app to correct your details and resubmit.',
    description: 'M-05 verification turned the whole application down, with the reviewing admin’s reason.',
  },
  {
    code: 'doctor_application_submitted',
    audience: ['admin'],
    placeholders: ['doctorName'],
    title: 'A provider application is ready to review',
    body: '{{doctorName}} has submitted their registration and documents for verification.',
    description: 'A self-registered provider finished onboarding (or resubmitted after a rejection).',
  },
  {
    code: 'case_assigned',
    audience: ['doctor'],
    placeholders: [],
    title: 'A case has been shared with you for review',
    body: 'A treating doctor has asked for your opinion on a case. Open the app to review it.',
    description:
      'M-17: an admin assigned a de-identified clarification case to this expert. Says nothing about the case itself (FR-16.2).',
  },
  {
    code: 'case_reply',
    audience: ['doctor'],
    placeholders: [],
    title: 'There is a reply on a case',
    body: 'A case you are involved in has a new reply. Open the app to read it.',
    description:
      'M-17: either side replied on a clarification case. Sent to whichever party did not write it.',
  },
];

export const TEMPLATES_KEY = 'notifications.templates';
export const FORBIDDEN_TERMS_KEY = 'notifications.forbidden_terms';

/**
 * *** THE OTHER HALF OF FR-16.2. ***
 *
 * "Notification text never names a diagnosis." The placeholder list stops a
 * template from ASKING for clinical content; this stops an editor from typing
 * it in by hand. Every term is checked against saved template copy and again
 * against the rendered text, because a variable can carry a word the template
 * itself never contained.
 *
 * It is an `app_config` value rather than a constant: which words count is a
 * clinical-governance judgement, it differs by language, and the client must be
 * able to add one the morning they think of it.
 */
export const FORBIDDEN_TERMS: string[] = [
  'diagnosis',
  'diagnosed',
  'depression',
  'depressive',
  'anxiety',
  'bipolar',
  'schizophrenia',
  'psychosis',
  'psychotic',
  'ocd',
  'obsessive compulsive',
  'ptsd',
  'adhd',
  'autism',
  'dementia',
  'addiction',
  'substance use',
  'suicidal',
  'self harm',
  'self-harm',
  'insomnia',
  'eating disorder',
  'personality disorder',
];

/** What an admin may change. The audience and the placeholder list are not copy. */
export const editableTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
});

export type EditableTemplate = z.infer<typeof editableTemplateSchema>;

/** The shape of the whole `notifications.templates` value. */
export const templatesConfigSchema = z.record(z.string(), editableTemplateSchema);

export const forbiddenTermsSchema = z.array(z.string().min(2)).max(500);

const TEMPLATES_BY_CODE = new Map(NOTIFICATION_TEMPLATES.map((t) => [t.code, t]));

export function templateDefinition(code: string): TemplateDefinition | undefined {
  return TEMPLATES_BY_CODE.get(code as NotificationCode);
}

/** The seed value: the shipped copy, keyed by code. */
export function defaultTemplateCopy(): Record<string, EditableTemplate> {
  return Object.fromEntries(
    NOTIFICATION_TEMPLATES.map((t) => [t.code, { title: t.title, body: t.body }]),
  );
}
