import { HttpException, HttpStatus } from '@nestjs/common';

/** Failure codes owned by the foundation. Modules add their own domain codes. */
export const PlatformError = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  /** The right kind of account, but not a high enough admin permission level. */
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  CONFLICT: 'CONFLICT',
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  /** The object store would not sign a URL. Shared by every module that stores files. */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** The one error body every endpoint returns. */
export interface ErrorResponse {
  statusCode: number;
  /** Stable machine-readable identifier; clients branch on this, never on the message. */
  code: string;
  message: string;
  details?: unknown;
  path: string;
  requestId: string;
  timestamp: string;
}

/**
 * A failure a client can act on. `code` is part of the contract and must not
 * change once released; `message` is human-facing and may be reworded freely.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
