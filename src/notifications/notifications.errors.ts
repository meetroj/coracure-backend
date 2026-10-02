/** M-08's failure codes. Clients branch on these, never on the message. */
export const NotificationsError = {
  /** No notification with that id, or it is addressed to somebody else. */
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  /** No template with that code. The codes are a fixed list in the build. */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** Copy referring to a variable this template does not carry. */
  UNKNOWN_PLACEHOLDER: 'UNKNOWN_PLACEHOLDER',
  /**
   * *** FR-16.2 *** The copy names a diagnosis. Refused when an admin saves it,
   * so wording that breaks the rule never reaches a single device.
   */
  CLINICAL_TERM_IN_COPY: 'CLINICAL_TERM_IN_COPY',
} as const;
