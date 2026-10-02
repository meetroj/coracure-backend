import { Global, Module } from '@nestjs/common';

import {
  AdminClarificationController,
  ExpertClarificationController,
  TreatingDoctorClarificationController,
} from './clarification.controller';
import { ClarificationService } from './clarification.service';

/**
 * M-17 Case Clarification. Owns `clarification_cases`.
 *
 * Lets a treating doctor get an expert opinion WITHOUT exposing the patient.
 * The de-identification is structural: the table has nowhere to put a name, a
 * phone number, an address or an email, and M-10's CHECK forbids a case
 * attachment from carrying a patient - so an attachment cannot be joined back
 * to a person even by mistake.
 *
 * It follows M-15 because a case is usually raised out of a consultation that
 * has been written up, and M-05 because expert seniority is a doctor attribute.
 * Global because M-20 reports on turnaround.
 *
 * Nothing here is patient-facing, by construction (FR-12.7).
 */
@Global()
@Module({
  controllers: [
    TreatingDoctorClarificationController,
    ExpertClarificationController,
    AdminClarificationController,
  ],
  providers: [ClarificationService],
  exports: [ClarificationService],
})
export class ClarificationModule {}
