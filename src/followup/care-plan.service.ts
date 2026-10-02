import { Inject, Injectable } from '@nestjs/common';

import { ClinicalRecordsService, PatientCareView } from '../clinical/clinical-records.service';
import { CONTENT_LIBRARY, ContentLibrary, ContentSummary } from '../clinical/content-library';
import { AuthenticatedActor } from '../common/auth';
import { FollowupPlan, FollowupService, TodaysCheckin } from './followup.service';

/**
 * FR-14.1's one screen, assembled.
 *
 * *** IT STORES NOTHING. ***
 *
 * Every part of a Care Plan is owned by the module that owns the fact:
 *
 *   the prescription and warning signs   M-15's clinical record
 *   today's check-in                     M-16, here
 *   the follow-up plan and its dates     M-16, here
 *   the follow-up booking                M-11's booking endpoints
 *   recommended self-help                M-18's content, when it exists
 *
 * A Care Plan table would be a fifth copy of four things, and the copy would be
 * stale the moment a doctor changed one of them. This service is a read across
 * the four, and the composition is the only thing it adds.
 */
export interface CarePlan {
  consultationId: string;
  /** Null until the doctor finalises. A draft is not a care plan. */
  care: PatientCareView | null;
  followup: FollowupPlan;
  /** Null outside the follow-up window, or when no follow-up is running. */
  today: TodaysCheckin | null;
  /**
   * FR-15.4's Care Hub picks, resolved through M-18's library so the patient
   * sees titles rather than ids - tagged "Recommended by your doctor" in the app.
   *
   * In the order the DOCTOR picked them, which is their clinical intent rather
   * than the library's shelf order. An item that no longer resolves is simply
   * absent: a Care Plan showing four of five recommendations is far better than
   * one that fails to load because an article was retired.
   */
  recommended: ContentSummary[];
  /**
   * SRS 6.3: reachable from the Care Plan and the home screen, always, and not
   * only after something has gone wrong.
   */
  emergencyGuidanceAvailable: boolean;
}

@Injectable()
export class CarePlanService {
  constructor(
    private readonly clinical: ClinicalRecordsService,
    private readonly followup: FollowupService,
    // Through the port M-15 declares, not by importing M-18: this module was
    // written before the library existed and does not depend on it directly.
    @Inject(CONTENT_LIBRARY) private readonly content: ContentLibrary,
  ) {}

  /**
   * The whole screen in one call.
   *
   * Each part is fetched through its owning module's own authorisation, so a
   * patient reaching this cannot see anything they could not have asked for
   * directly. A part that is not ready yet comes back null rather than failing
   * the request: a patient whose doctor has not finished writing up should
   * still see their check-in.
   */
  async forPatient(consultationId: string, actor: AuthenticatedActor): Promise<CarePlan> {
    const followup = await this.followup.planFor(consultationId, actor);

    const care = await this.clinical
      .forPatient(consultationId, actor)
      // Not yet issued. The rest of the plan is still worth showing.
      .catch(() => null);

    const today = await this.followup
      .todaysCheckin(consultationId, actor)
      // Outside the window, or no follow-up running. Both are ordinary states.
      .catch(() => null);

    return {
      consultationId,
      care,
      followup,
      today,
      recommended: await this.content.summaries(care?.recommendedContentIds ?? []),
      emergencyGuidanceAvailable: true,
    };
  }
}
