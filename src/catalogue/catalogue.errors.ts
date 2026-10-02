/** M-06's failure codes. Clients branch on these, never on the message. */
export const CatalogueError = {
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
  CONCERN_NOT_FOUND: 'CONCERN_NOT_FOUND',
  REGION_NOT_FOUND: 'REGION_NOT_FOUND',
  /** That code is already taken. Codes are the stable handle, so they are unique. */
  CODE_ALREADY_EXISTS: 'CODE_ALREADY_EXISTS',
  /** Only a doctor-form specialty may prescribe. Also a CHECK on the table. */
  ONLY_DOCTORS_PRESCRIBE: 'ONLY_DOCTORS_PRESCRIBE',
  /** Disabling a specialty or region that providers are still registered under. */
  STILL_IN_USE: 'STILL_IN_USE',
} as const;
