import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuthenticatedActor } from '../common/auth';

/**
 * How the platform picks a provider when more than one qualifies, and what it
 * does when none does. SRS 4.20.
 *
 * Configuration, not code: the client changes how work is spread, or how many
 * times a patient may decline, without a release. M-06 owns this because M-06
 * owns the catalogue the rules match against; M-11 reads it to make the
 * decision and M-13 reads the same value when it re-routes.
 *
 * What is NOT configurable is deliberate. Language is always a hard
 * requirement (FR-20.4): a provider who cannot speak to the patient is never
 * assigned, and no admin setting can relax that. Only region bends.
 */
export const ALLOCATION_POLICY_KEY = 'allocation.policy';

export const TIE_BREAKS = ['fewest_upcoming', 'least_recently_assigned', 'longest_free'] as const;
export type TieBreak = (typeof TIE_BREAKS)[number];

const POLICY = z.object({
  /**
   * FR-20.5. True means assignment may go outside the patient's region when
   * nobody in it is free, recording that it did. Set false only when the
   * client is confident every region's pool can cover its own demand - a hard
   * region rule with a thin pool leaves patients unable to book at all.
   */
  regionRelaxable: z.boolean(),
  /** FR-20.6. How the tie is broken when several providers qualify. */
  tieBreak: z.enum(TIE_BREAKS),
  /** FR-4.4. How many times one patient may decline before the booking stands. */
  maxPatientDeclines: z.number().int().min(0).max(10),
});

export type AllocationPolicy = z.infer<typeof POLICY>;

/**
 * Installed on first boot. `fewest_upcoming` is the load-balancing default the
 * SRS asks for: work spreads across the pool rather than landing on whichever
 * provider happens to sort first.
 */
export const ALLOCATION_POLICY_DEFAULTS: AllocationPolicy = {
  regionRelaxable: true,
  tieBreak: 'fewest_upcoming',
  maxPatientDeclines: 2,
};

@Injectable()
export class AllocationPolicyService {
  constructor(private readonly config: AppConfigService) {}

  /** The policy in force. Falls back to the defaults rather than throwing. */
  async current(): Promise<AllocationPolicy> {
    return {
      ...ALLOCATION_POLICY_DEFAULTS,
      ...((await this.config.get(ALLOCATION_POLICY_KEY, POLICY.partial())) ?? {}),
    };
  }

  /** Admin edit. The before and after are recorded by `AppConfigService.set`. */
  async update(
    patch: Partial<AllocationPolicy>,
    actor: AuthenticatedActor,
  ): Promise<AllocationPolicy> {
    const next = POLICY.parse({ ...(await this.current()), ...patch });
    await this.config.set(ALLOCATION_POLICY_KEY, next, { type: actor.type, id: actor.id });
    return next;
  }
}
