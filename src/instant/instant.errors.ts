/** M-13's failure codes. Clients branch on these, never on the message. */
export const InstantError = {
  /** No instant request with that id, or it is not the caller's. */
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  /** No offer open for this provider on that request. */
  OFFER_NOT_FOUND: 'OFFER_NOT_FOUND',
  /** The acceptance window closed, or somebody else took it first. */
  OFFER_CLOSED: 'OFFER_CLOSED',
  /** FR-10.5: notes from an earlier consultation are still outstanding. */
  DOCUMENTATION_OUTSTANDING: 'DOCUMENTATION_OUTSTANDING',
  /** A state the platform sets as things happen, not one a provider picks. */
  PRESENCE_NOT_SELF_SETTABLE: 'PRESENCE_NOT_SELF_SETTABLE',
  /** Nobody in the pool is available now. Carries no "try later" - see M-11. */
  NO_ONE_AVAILABLE: 'NO_ONE_AVAILABLE',
  /** The provider is not verified, listed, or permitted instant work. */
  DOCTOR_NOT_AVAILABLE: 'DOCTOR_NOT_AVAILABLE',
  /** The request has already been answered, cancelled or expired. */
  REQUEST_CLOSED: 'REQUEST_CLOSED',
} as const;
