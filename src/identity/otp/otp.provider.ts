/**
 * The OTP port. Slide owns generation, expiry and attempt state (SRS 3.3), so
 * nothing about a challenge is persisted here - this platform learns only
 * whether a verification succeeded.
 *
 * The platform's OWN rate limit is enforced separately, in
 * `LoginRateLimitService`, because FR-1.9 makes it the platform's obligation
 * regardless of what the provider does at their end.
 */
export const OTP_PROVIDER = Symbol('OtpProvider');

/** Which flow the code is for. Providers may use different templates per purpose. */
export type OtpPurpose = 'patient_signin' | 'doctor_signin' | 'admin_2fa';

export interface OtpChallenge {
  /**
   * Opaque handle the client returns with the code. It is NOT a secret and NOT
   * proof of anything - `verify` is what decides. A provider keyed only by
   * mobile number may return the number itself.
   */
  challengeId: string;
}

export interface OtpProvider {
  /** Asks the provider to send a code. Throws only if the provider is unreachable. */
  request(mobileNumber: string, purpose: OtpPurpose): Promise<OtpChallenge>;

  /** True when the code is correct and unused. A wrong code is `false`, not a throw. */
  verify(challengeId: string, code: string): Promise<boolean>;
}
