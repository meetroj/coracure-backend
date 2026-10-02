/** M-10's failure codes. Clients branch on these, never on the message. */
export const FilesError = {
  /** No file with that id, or the caller is not inside that patient's care. */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** No request with that id, or it belongs to a consultation the caller cannot see. */
  REPORT_REQUEST_NOT_FOUND: 'REPORT_REQUEST_NOT_FOUND',
  /** A request already fulfilled or cancelled cannot be changed again. */
  REPORT_REQUEST_CLOSED: 'REPORT_REQUEST_CLOSED',
  /** The storage key was not one this service issued to this caller. */
  UPLOAD_NOT_RECOGNISED: 'UPLOAD_NOT_RECOGNISED',
  /** Deleting a file that a completed consultation relied on. */
  FILE_IS_PART_OF_A_RECORD: 'FILE_IS_PART_OF_A_RECORD',
  /** That consultation does not exist, or is not the caller's. */
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  /** A category a client may not upload - a prescription PDF is generated, not sent. */
  CATEGORY_NOT_UPLOADABLE: 'CATEGORY_NOT_UPLOADABLE',
} as const;
