/**
 * M-02's failure codes. Clients branch on these, never on the message, so a
 * code is part of the contract once released.
 */
export const IdentityError = {
  /** Wrong OTP, wrong password, or an account that does not exist. Deliberately one code. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** The platform's own FR-1.9 limit, counted from the audit log. */
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  /** Suspended or deleted. The account exists but may not sign in. */
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
  /** A patient token on the doctor app, an admin token on the patient app, and so on. */
  WRONG_APP_FOR_ACCOUNT: 'WRONG_APP_FOR_ACCOUNT',
  /** Expired, malformed, or issued before a `token_version` bump. */
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** Password verified, but the admin has 2FA on and has not answered the challenge. */
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  /** Slide is unreachable. Nothing to do with the code the user typed. */
  OTP_PROVIDER_UNAVAILABLE: 'OTP_PROVIDER_UNAVAILABLE',
} as const;
