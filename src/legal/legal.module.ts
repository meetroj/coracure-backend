import { Global, Module } from '@nestjs/common';

import { ConsentsService } from './consents.service';
import { DataDeletionService } from './data-deletion.service';
import { LegalController } from './legal.controller';
import { LegalDocumentsService } from './legal-documents.service';

/**
 * M-03 Consent and Legal. Owns `legal_documents`, `consents` and
 * `data_deletion_requests`.
 *
 * Global because `ConsentsService.assertTeleconsultationConsent` is the
 * pre-consult gate M-11 and M-14 both call. Keeping it a method rather than a
 * column means there is exactly one implementation of the rule.
 */
@Global()
@Module({
  controllers: [LegalController],
  providers: [LegalDocumentsService, ConsentsService, DataDeletionService],
  exports: [LegalDocumentsService, ConsentsService, DataDeletionService],
})
export class LegalModule {}
