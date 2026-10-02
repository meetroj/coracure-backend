import { Global, Module } from '@nestjs/common';

import {
  AdminSupportController,
  PatientComplaintsController,
  PatientFeedbackController,
} from './support.controller';
import { SupportService } from './support.service';

/**
 * M-19 Feedback and Complaints. Owns `complaints`; writes M-11's two feedback
 * columns on the consultation.
 *
 * Post-consult feedback gets no table of its own: a rating has no workflow, no
 * thread and no assignee, so it is two columns on the appointment it is about.
 * A complaint has all three, which is why it is a table.
 *
 * Global because M-20's quality dashboard counts complaints by category and
 * reads the ratings behind a provider's reliability figures.
 */
@Global()
@Module({
  controllers: [PatientFeedbackController, PatientComplaintsController, AdminSupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
