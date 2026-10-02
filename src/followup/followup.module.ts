import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { CarePlanService } from './care-plan.service';
import {
  CHECKIN_PROMPT_HOUR_KEY,
  CheckinSweeperService,
  DEFAULT_CHECKIN_PROMPT_HOUR,
  DEFAULT_MISSED_CHECKIN_THRESHOLD,
  MISSED_CHECKIN_THRESHOLD_KEY,
} from './checkin-sweeper.service';
import {
  AdminFollowupController,
  DoctorFollowupController,
  PatientFollowupController,
} from './followup.controller';
import { FollowupService } from './followup.service';
import { PathwaysService } from './pathways.service';
import { SafetyAlertsService } from './safety-alerts.service';

/**
 * M-16 Follow-Up and Patient Safety. Owns `followup_pathways`,
 * `checkin_responses` and `safety_alerts`.
 *
 * The platform's differentiator, so the rules are DATA: an admin edits the
 * question sets and the red-flag thresholds with no app release behind them
 * (FR-13.7), and a rule that turns out to fire too often is fixable this
 * afternoon for patients already mid-follow-up.
 *
 * It follows M-15 because a follow-up plan is assigned once the clinical record
 * is finalised, and reads M-15 again to compose the Care Plan. Global because
 * M-20 reports on adherence and alert outcomes.
 */
@Global()
@Module({
  controllers: [PatientFollowupController, DoctorFollowupController, AdminFollowupController],
  providers: [
    FollowupService,
    PathwaysService,
    SafetyAlertsService,
    CarePlanService,
    CheckinSweeperService,
  ],
  exports: [FollowupService, PathwaysService, SafetyAlertsService, CarePlanService],
})
export class FollowupModule implements OnModuleInit {
  constructor(
    private readonly config: AppConfigService,
    private readonly pathways: PathwaysService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: MISSED_CHECKIN_THRESHOLD_KEY,
        value: DEFAULT_MISSED_CHECKIN_THRESHOLD,
        description:
          'Consecutive missed days before a missed-check-in alert is raised (FR-13.3). One missed day is a busy afternoon; two is a pattern. Setting this to 1 alerts on every patient who goes to bed early, which is how a governance queue stops being read.',
        schema: z.number().int().min(1).max(7),
        editableBy: ['clinical_governance', 'care_coordinator'],
      },
      {
        key: CHECKIN_PROMPT_HOUR_KEY,
        value: DEFAULT_CHECKIN_PROMPT_HOUR,
        description:
          'The hour, in the platform time zone, that the daily check-in prompt goes out (FR-16.1). Late enough that “how has today been” has an answer, early enough that the patient is awake to give it.',
        schema: z.number().int().min(0).max(23),
        editableBy: ['clinical_governance', 'care_coordinator'],
      },
    ]);
    // FR-13.1's five, as PLACEHOLDER clinical content. Never overwritten: from
    // the first admin edit the rows are the truth (SRS 8, FR-13.7).
    await this.pathways.seedDefaults();
  }
}
