import { Injectable, Logger } from '@nestjs/common';

import { env } from '../../config/env.validation';
import { OtpChallenge, OtpProvider, OtpPurpose } from './otp.provider';

/**
 * Local and test provider. Accepts one fixed code so the sign-in flow can be
 * driven end to end without a Slide account. `env.validation` refuses to boot
 * production with this selected.
 */
@Injectable()
export class StubOtpProvider implements OtpProvider {
  private readonly logger = new Logger(StubOtpProvider.name);

  request(mobileNumber: string, purpose: OtpPurpose): Promise<OtpChallenge> {
    this.logger.warn(
      { mobileNumber, purpose, code: env().OTP_STUB_CODE },
      'Stub OTP provider - no message was sent',
    );
    return Promise.resolve({ challengeId: mobileNumber });
  }

  verify(_challengeId: string, code: string): Promise<boolean> {
    return Promise.resolve(code === env().OTP_STUB_CODE);
  }
}
