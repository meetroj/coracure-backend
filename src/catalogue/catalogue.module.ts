import { Global, Module, OnModuleInit } from '@nestjs/common';

import { AppConfigService } from '../app-config/app-config.service';
import { SPECIALTY_CATALOGUE } from '../doctors/specialty-catalogue';
import {
  ALLOCATION_POLICY_DEFAULTS,
  ALLOCATION_POLICY_KEY,
  AllocationPolicyService,
} from './allocation-policy.service';
import { AdminCatalogueController, CatalogueController } from './catalogue.controller';
import { ConcernsService } from './concerns.service';
import { RegionsService } from './regions.service';
import { DatabaseSpecialtyCatalogue } from './specialty-catalogue.adapter';
import { SpecialtiesService } from './specialties.service';

/**
 * M-06 Catalogue, Specialty and Allocation Configuration. Owns `specialties`,
 * `concerns` and `regions` - everything assignment matches against.
 * 
 * It also supplies M-05's `SPECIALTY_CATALOGUE` port. M-05 declared that port
 * with a deliberately conservative default because it was built first; this is
 * the module that owns the answers, so this is the module that binds it. That
 * is why `DoctorsModule` no longer provides the token, and why this module is
 * listed before it in `AppModule`.
 *
 * `doctor_regions` is NOT here. Which regions a provider serves is an attribute
 * of that provider, so M-05 owns it - exactly as M-05 owns
 * `doctors.specialty_id` while this module owns the specialty it points at.
 */
@Global()
@Module({
  controllers: [CatalogueController, AdminCatalogueController],
  providers: [
    SpecialtiesService,
    ConcernsService,
    RegionsService,
    AllocationPolicyService,
    { provide: SPECIALTY_CATALOGUE, useClass: DatabaseSpecialtyCatalogue },
  ],
  exports: [
    SpecialtiesService,
    ConcernsService,
    RegionsService,
    AllocationPolicyService,
    SPECIALTY_CATALOGUE,
  ],
})
export class CatalogueModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** The allocation policy becomes admin-editable data on first boot (SRS 4.20). */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: ALLOCATION_POLICY_KEY,
        value: ALLOCATION_POLICY_DEFAULTS,
        description:
          'How a provider is picked when several qualify, and whether region may be relaxed when none does (SRS 4.20). Language is never relaxed and is not settable here.',
        // Has its own screen, which validates more than a shape check could.
        managedBy: 'allocation policy',
      },
    ]);
  }
}
