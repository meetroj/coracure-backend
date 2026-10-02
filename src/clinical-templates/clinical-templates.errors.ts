/** Clinical templates' failure codes. Clients branch on these, never on the message. */
export const ClinicalTemplateError = {
  /** No such template, or not one this doctor owns. */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** The doctor already holds the maximum number of templates. */
  TEMPLATE_LIMIT_REACHED: 'TEMPLATE_LIMIT_REACHED',
} as const;
