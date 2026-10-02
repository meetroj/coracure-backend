import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import { AppException } from '../../common/errors';
import { env } from '../../config/env.validation';
import { IdentityError } from '../identity.errors';
import { OtpChallenge, OtpProvider, OtpPurpose } from './otp.provider';

/**
 * Slide, the platform's OTP provider (SRS 2.5, 3.3).
 *
 * The contract below is Slide's PUBLISHED one, confirmed against
 * `https://slide.synquic.com/docs/api-reference` and exercised against the live
 * API - it is no longer the provisional guess SRS 3.3 recorded:
 *
 *   POST {base}/v1/otp/send    {widgetId, identifier}  -> {requestId}
 *   POST {base}/v1/otp/verify  {requestId, otp}        -> {accessToken}
 *
 * `identifier` is the E.164 number, which is the only form this platform holds.
 * The `requestId` is what `OtpChallenge.challengeId` carries, so nothing outside
 * this file learns Slide's vocabulary.
 */
@Injectable()
export class SlideOtpProvider implements OtpProvider {
  private readonly logger = new Logger(SlideOtpProvider.name);

  /**
   * *** `purpose` IS NOT SENT. ***
   *
   * Slide has no template field: the WIDGET owns the message, so the wording of
   * a patient sign-in and a doctor sign-in is one dashboard setting rather than
   * something this service chooses per call. The parameter stays because the
   * port has it and a second widget id per purpose is the obvious way to vary
   * the message later - the day that happens, it is a lookup here and nothing
   * else changes.
   */
  async request(mobileNumber: string, purpose: OtpPurpose): Promise<OtpChallenge> {
    const { SLIDE_WIDGET_ID } = env();
    const { status, body } = await this.call<{ requestId?: string }>('/v1/otp/send', {
      widgetId: SLIDE_WIDGET_ID,
      identifier: mobileNumber,
    });

    if (status >= 400) {
      // A send is never the user getting something wrong - they have typed a
      // number and nothing else. Every rejection here is ours or Slide's.
      this.logger.error({ status, purpose }, 'Slide refused to send a code');
      throw unavailable();
    }
    if (!body.requestId) {
      this.logger.error({ body }, 'Slide accepted the send but returned no requestId');
      throw unavailable();
    }
    return { challengeId: body.requestId };
  }

  /**
   * *** A REJECTED CODE IS `false`, NOT AN OUTAGE. ***
   *
   * Slide answers a wrong or expired code with a 4xx, and the port is explicit
   * that only an unreachable provider throws. Returning the outage instead
   * would tell a patient who fat-fingered a digit that the service is down, and
   * - worse - `LoginRateLimitService` would never see the failed attempt that
   * FR-1.9 obliges us to count.
   *
   * 401 and 403 are the exception among 4xx: those are OUR key being wrong, not
   * the user's code, and a misconfigured deployment must not read as every
   * patient typing the wrong digits.
   */
  async verify(challengeId: string, code: string): Promise<boolean> {
    const { status, body } = await this.call<{ accessToken?: string }>('/v1/otp/verify', {
      requestId: challengeId,
      otp: code,
    });

    // Raw codes rather than `HttpStatus`: `status` is whatever Slide put on the
    // wire, not a value from Nest's enum, and comparing the two is exactly what
    // `no-unsafe-enum-comparison` exists to catch. The rest of this file already
    // reads the status as a number.
    if (status === 401 || status === 403) {
      this.logger.error({ status }, 'Slide rejected our credentials on a verify');
      throw unavailable();
    }
    if (status === 429 || status >= 500) {
      this.logger.error({ status }, 'Slide could not answer a verify');
      throw unavailable();
    }
    // Anything else in the 4xx range is Slide saying this code is not the one.
    if (status >= 400) return false;

    // The token is proof the code was right. It is deliberately NOT returned or
    // stored: this platform issues its own credentials, and a second bearer
    // token for a third party's session has no business in our token flow.
    return Boolean(body.accessToken);
  }

  /**
   * Returns the status alongside the body rather than throwing on it, because
   * only the caller knows whether a 4xx is an outage or an answer. A transport
   * failure is the one case decided here - there is no status to interpret.
   */
  private async call<T>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: T }> {
    const config = env();
    let response: Response;
    try {
      response = await fetch(`${config.SLIDE_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.SLIDE_API_KEY ?? ''}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.SLIDE_TIMEOUT_MS),
      });
    } catch (error) {
      // Unreachable or timed out. Never leak the provider's identity to the caller.
      this.logger.error({ err: error, path }, 'Slide request failed');
      throw unavailable();
    }

    // A body is not guaranteed on an error status, and a provider that returns
    // HTML for a 502 must not turn into a 500 here.
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      body = {} as T;
    }
    return { status: response.status, body };
  }
}

/** The same 502 whatever went wrong, so the caller never learns who Slide is. */
function unavailable(): AppException {
  return new AppException(
    IdentityError.OTP_PROVIDER_UNAVAILABLE,
    'Could not send the verification code. Please try again.',
    HttpStatus.BAD_GATEWAY,
  );
}
