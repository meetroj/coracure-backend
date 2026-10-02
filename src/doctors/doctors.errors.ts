/**
 * M-05's failure codes. Clients branch on these, never on the message, so a
 * code is part of the contract once released.
 */
export const DoctorsError = {
  /** No doctor with that id. Also returned where hiding existence is the point. */
  DOCTOR_NOT_FOUND: 'DOCTOR_NOT_FOUND',
  /** That mobile number or registration number already belongs to a doctor. */
  DOCTOR_ALREADY_EXISTS: 'DOCTOR_ALREADY_EXISTS',
  /** Verification asked for while a required credential is missing or unapproved. */
  CREDENTIALS_INCOMPLETE: 'CREDENTIALS_INCOMPLETE',
  /** Listing asked for on a doctor who is not verified. Two separate actions, in order. */
  DOCTOR_NOT_VERIFIED: 'DOCTOR_NOT_VERIFIED',
  /** Signed in, but not through verification yet - the doctor experience is closed. */
  DOCTOR_NOT_APPROVED: 'DOCTOR_NOT_APPROVED',
  /** No document with that id, or it belongs to another doctor. */
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** A document already reviewed cannot be reviewed again; the doctor re-uploads. */
  DOCUMENT_ALREADY_REVIEWED: 'DOCUMENT_ALREADY_REVIEWED',
  /** The storage key was not one this service issued to this doctor. */
  UPLOAD_NOT_RECOGNISED: 'UPLOAD_NOT_RECOGNISED',
  /** Object storage would not sign the URL. Nothing the caller did wrong. */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /** The self-registration is closed once an admin has verified the account. */
  REGISTRATION_LOCKED: 'REGISTRATION_LOCKED',
} as const;
