/** M-18's failure codes. Clients branch on these, never on the message. */
export const ContentError = {
  /** No such item, or not one that is published. The same answer to both. */
  CONTENT_NOT_FOUND: 'CONTENT_NOT_FOUND',
  /** The shape does not hold together - see `assertShapeIsCoherent`. */
  CONTENT_INVALID: 'CONTENT_INVALID',
  /** A slug is what a deep link carries, so two items cannot share one. */
  SLUG_TAKEN: 'SLUG_TAKEN',
  /** The action does not belong to this review status. */
  NOT_IN_THAT_STATE: 'NOT_IN_THAT_STATE',
  /**
   * *** FR-15.4. *** A doctor picked something that is not a published item.
   * Named separately from CONTENT_NOT_FOUND because the caller is a clinician
   * saving a record, not a reader opening an article.
   */
  NOT_RECOMMENDABLE: 'NOT_RECOMMENDABLE',
} as const;
