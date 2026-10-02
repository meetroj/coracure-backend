import { Global, Module } from '@nestjs/common';

import { ClinicalRecordsService } from './clinical-records.service';
import {
  AdminClinicalController,
  DoctorClinicalController,
  PatientClinicalController,
} from './clinical.controller';

/**
 * M-15 Clinical Records. Owns `clinical_records`, one row per consultation.
 *
 * It follows M-11 and M-14 because a record is written up AFTER a consultation
 * has been held, and it reaches M-06 through the `SPECIALTY_CATALOGUE` port
 * M-05 declared - prescribing eligibility is a property of the specialty, and
 * this module only asks the question.
 *
 * Global because the record is what later modules read to do their work: M-16
 * takes the warning signs and the risk category into the Care Plan, M-17 builds
 * a de-identified clarification case from it, and M-20 reports on completion.
 *
 * It DECLARES the `CONTENT_LIBRARY` port but does NOT bind it, exactly as M-05
 * declares `SPECIALTY_CATALOGUE` and leaves M-06 to supply it. FR-15.4's Care
 * Hub picks are checked against a library M-18 owns, so M-18 binds the token
 * and this module injects it.
 *
 * *** THE DEFAULT WAS REMOVED FOR A REASON, AND IT COST A BUG TO LEARN. ***
 * `NoContentLibrary` was bound here as a fail-closed default. A module's own
 * provider WINS over a global one, so M-18 registering the real library changed
 * nothing: every pick stayed unrecommendable, and a doctor could not recommend
 * a published article. M-11's note in `app.module.ts` warns about exactly this
 * - "leaving the default in place would have kept every one of them shut" - and
 * it was written after the same mistake. Not binding it at all means a missing
 * M-18 fails LOUDLY at boot rather than quietly refusing every recommendation.
 */
@Global()
@Module({
  controllers: [DoctorClinicalController, PatientClinicalController, AdminClinicalController],
  providers: [ClinicalRecordsService],
  exports: [ClinicalRecordsService],
})
export class ClinicalModule {}
