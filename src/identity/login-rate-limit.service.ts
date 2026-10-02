import { HttpStatus, Injectable } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { ActorType } from '../common/auth';
import { AppException } from '../common/errors';
import { IdentityError } from './identity.errors';

/**
 * FR-1.9 makes rate limiting the PLATFORM's obligation, in addition to
 * whatever Slide applies at their end (SRS 3.3 records that Slide's own limits
 * are still to be confirmed). Since OTP attempt state left the database with
 * Slide, the count is read from `audit_log` where `action = 'login'` - the one
 * place that already records every attempt. There is no counter column and no
 * second table, so a restart cannot reset a limit and the limit is per
 * identifier rather than per IP.
 */
export type LoginFlow =
  | 'patient_otp_request'
  | 'patient_otp_verify'
  | 'doctor_otp_request'
  | 'doctor_otp_verify'
  | 'admin_login';

const RULE = z.object({
  limit: z.number().int().min(1),
  windowMinutes: z.number().int().min(1),
});
/**
 * Every flow is OPTIONAL, and a missing one falls back to its default. That is
 * what lets a later module add a flow: `seed` leaves an existing
 * `identity.rate_limits` value alone, so on an upgraded environment the stored
 * value knows nothing about the flows added since. Requiring all of them would
 * turn that into a 500 on every sign-in.
 */
export const RATE_LIMIT_SCHEMA = z
  .object({
    patient_otp_request: RULE,
    patient_otp_verify: RULE,
    doctor_otp_request: RULE,
    doctor_otp_verify: RULE,
    admin_login: RULE,
    /** Codes one client address may ask a doctor flow to SEND, whatever the numbers. */
    doctor_otp_request_per_ip: RULE,
  })
  .partial();
type Rules = Required<z.infer<typeof RATE_LIMIT_SCHEMA>>;

/** Installed on first boot; an admin may then change them without a release. */
export const RATE_LIMIT_DEFAULTS: Rules = {
  patient_otp_request: { limit: 5, windowMinutes: 15 },
  patient_otp_verify: { limit: 10, windowMinutes: 15 },
  // The same ceiling as a patient's.
  doctor_otp_request: { limit: 5, windowMinutes: 15 },
  doctor_otp_verify: { limit: 10, windowMinutes: 15 },
  admin_login: { limit: 10, windowMinutes: 15 },
  // Doctor sign-up is open, so every code is an SMS the client pays for. The
  // per-number limit above cannot stop one client asking for codes to a
  // thousand DIFFERENT numbers; this one counts by address instead.
  doctor_otp_request_per_ip: { limit: 10, windowMinutes: 60 },
};

export const RATE_LIMIT_KEY = 'identity.rate_limits';

/** Which account table an attempt on this flow is an attempt against. */
const ACTOR_OF: Record<LoginFlow, ActorType> = {
  patient_otp_request: 'patient',
  patient_otp_verify: 'patient',
  doctor_otp_request: 'doctor',
  doctor_otp_verify: 'doctor',
  admin_login: 'admin',
};

@Injectable()
export class LoginRateLimitService {
  constructor(
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Throws when `identifier` has already used up the window. Call BEFORE doing
   * the work, and `record` after - a blocked attempt must not extend its own
   * ban, or a locked-out user could never come back.
   */
  async assertWithinLimit(flow: LoginFlow, identifier: string): Promise<void> {
    const stored = await this.config.get(RATE_LIMIT_KEY, RATE_LIMIT_SCHEMA);
    const rule = stored?.[flow] ?? RATE_LIMIT_DEFAULTS[flow];
    const since = new Date(Date.now() - rule.windowMinutes * 60_000);

    const attempts = await this.audit.countSince({
      action: 'login',
      entityType: flow,
      entityId: identifier,
      since,
    });

    if (attempts >= rule.limit) {
      throw new AppException(
        IdentityError.TOO_MANY_ATTEMPTS,
        `Too many attempts. Please try again in ${rule.windowMinutes} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Throws when one client address has asked for too many doctor codes, to any
   * numbers. A missing address (no proxy header, a test) is not limited here:
   * there is nothing to count by.
   */
  async assertIpWithinLimit(ipAddress: string | null | undefined): Promise<void> {
    if (!ipAddress) return;
    const stored = await this.config.get(RATE_LIMIT_KEY, RATE_LIMIT_SCHEMA);
    const rule = stored?.doctor_otp_request_per_ip ?? RATE_LIMIT_DEFAULTS.doctor_otp_request_per_ip;
    const attempts = await this.audit.countSince({
      action: 'login',
      entityType: 'doctor_otp_request',
      ipAddress,
      since: new Date(Date.now() - rule.windowMinutes * 60_000),
    });
    if (attempts >= rule.limit) {
      throw new AppException(
        IdentityError.TOO_MANY_ATTEMPTS,
        `Too many attempts. Please try again in ${rule.windowMinutes} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Writes the attempt that the count above reads. Every attempt is recorded,
   * successful or not: the log is the sign-in history as well as the limit, and
   * FR-1.8 asks for the IP and user agent of each one.
   */
  async record(
    flow: LoginFlow,
    identifier: string,
    outcome: { succeeded: boolean; accountId?: string | null; reason?: string },
    context: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<void> {
    await this.audit.record({
      actorType: ACTOR_OF[flow],
      actorId: outcome.accountId ?? null,
      action: 'login',
      entityType: flow,
      entityId: identifier,
      metadata: {
        succeeded: outcome.succeeded,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        userAgent: context.userAgent ?? null,
      },
      ipAddress: context.ipAddress,
    });
  }
}
