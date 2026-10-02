/**
 * M-03's failure codes. Clients branch on these, never on the message, so a
 * code is part of the contract once released.
 */
export const LegalError = {
  /** No current version of that document type is published yet. */
  DOCUMENT_NOT_PUBLISHED: 'DOCUMENT_NOT_PUBLISHED',
  /** That type and version already exist. A version is a row, and rows are never rewritten. */
  VERSION_ALREADY_EXISTS: 'VERSION_ALREADY_EXISTS',
  /**
   * *** THE PRE-CONSULT GATE *** the patient has not accepted the CURRENT
   * teleconsultation consent. Raised by `ConsentsService.assertTeleconsultationConsent`.
   */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** The patient already has a deletion request that is still being handled. */
  DELETION_REQUEST_IN_PROGRESS: 'DELETION_REQUEST_IN_PROGRESS',
  /** The request has moved past the state this transition is valid from. */
  DELETION_REQUEST_NOT_PENDING: 'DELETION_REQUEST_NOT_PENDING',
} as const;
