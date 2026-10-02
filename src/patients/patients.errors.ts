/** M-04's failure codes. Clients branch on these, never on the message. */
export const PatientsError = {
  /** Not a real calendar date, in the future, or an implausible age. */
  INVALID_DATE_OF_BIRTH: 'INVALID_DATE_OF_BIRTH',
} as const;
