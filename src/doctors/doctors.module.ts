import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AppConfigService } from '../app-config/app-config.service';
import { AdminDoctorsController } from './admin-doctors.controller';
import { objectStorageClass } from '../storage/object-storage';
import { StubUploadController } from '../storage/stub-upload.controller';
import { env } from '../config/env.validation';
import { CREDENTIAL_STORAGE } from './credential-storage';
import { VerifiedDoctorGuard } from './doctor-access';
import { DoctorRegistrationService } from './doctor-registration.service';
import { DoctorRegistryService } from './doctor-registry.service';
import { DoctorVerificationService } from './doctor-verification.service';
import { DoctorsController } from './doctors.controller';
import {
  BASELINE_DOCUMENTS_KEY,
  BASELINE_REQUIRED_DOCUMENTS,
  REQUIRED_DOCUMENTS_SCHEMA,
} from './specialty-catalogue';

/**
 * M-05 Doctor Registry and Verification. Owns `doctors` and `doctor_documents`.
 *
 * Global because every module from M-07 on reads a doctor through
 * `DoctorRegistryService` and gates its own doctor routes with
 * `@VerifiedDoctorsOnly()` - MODULES 7, "one module owns each piece of data;
 * others read it through that module's public interface".
 *
 * It DECLARES the `SPECIALTY_CATALOGUE` port but no longer binds it: M-06 owns
 * `specialties`, so M-06 supplies the implementation and this module injects
 * it. `DOCTOR_METRICS` (M-11 and M-13) and `CREDENTIAL_STORAGE` (the
 * environment) are still bound here with conservative defaults.
 */
@Global()
@Module({
  // The stub's PUT sink is mounted ONLY when the stub is the provider, so an
  // `s3` deployment has no such route at all. Production cannot reach this
  // branch: `env.validation` refuses any provider but `s3` there.
  controllers: [
    DoctorsController,
    AdminDoctorsController,
    ...(env().STORAGE_PROVIDER === 'stub' ? [StubUploadController] : []),
  ],
  providers: [
    DoctorRegistryService,
    DoctorRegistrationService,
    DoctorVerificationService,
    {
      provide: CREDENTIAL_STORAGE,
      // `env.validation` refuses the stub in production, so a deployment cannot
      // silently accept credential uploads that are never stored.
      useClass: objectStorageClass(),
    },
    { provide: APP_GUARD, useClass: VerifiedDoctorGuard },
  ],
  exports: [DoctorRegistryService, DoctorVerificationService, CREDENTIAL_STORAGE],
})
export class DoctorsModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /**
   * The credentials every doctor submits whatever their specialty become
   * admin-editable data on first boot. M-06's specialty rows extend this per
   * specialty; the baseline is what stops verification being possible with no
   * documents at all.
   */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: BASELINE_DOCUMENTS_KEY,
        value: BASELINE_REQUIRED_DOCUMENTS,
        description:
          'Credentials every doctor must have approved before verification, whatever their specialty (MODULES M-05).',
        schema: REQUIRED_DOCUMENTS_SCHEMA,
        editableBy: ['operations', 'clinical_governance'],
      },
    ]);
  }
}
