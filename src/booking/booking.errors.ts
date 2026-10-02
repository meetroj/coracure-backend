/** M-11's failure codes. Clients branch on these, never on the message. */
export const BookingError = {
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  /** FR-20.10: assignment has nothing to match on until the profile carries both. */
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  /** FR-20.7: nobody in the pool qualifies. Carries the next time one can. */
  NO_PROVIDER_AVAILABLE: 'NO_PROVIDER_AVAILABLE',
  /** Somebody took the slot between the check and the write. */
  SLOT_TAKEN: 'SLOT_TAKEN',
  /** The service does not exist, or is no longer offered. */
  SERVICE_NOT_AVAILABLE: 'SERVICE_NOT_AVAILABLE',
  /** A change asked for on a consultation whose status does not allow it. */
  NOT_CHANGEABLE: 'NOT_CHANGEABLE',
  /** FR-4.4: the configured number of declines is used up. */
  DECLINE_LIMIT_REACHED: 'DECLINE_LIMIT_REACHED',
  /** An override naming a provider who cannot take it. */
  OVERRIDE_NOT_POSSIBLE: 'OVERRIDE_NOT_POSSIBLE',
} as const;
