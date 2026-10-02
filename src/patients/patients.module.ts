import { Global, Module } from '@nestjs/common';

import { PatientProfileService } from './patient-profile.service';
import { PatientsController } from './patients.controller';

/**
 * M-04 Patient Profile. Owns no table: the profile is columns on the
 * `patients` row M-02 owns.
 *
 * Global because MODULES M-04 makes this the only way other modules read a
 * patient - "profile read by other modules through this module only" - so the
 * rule about who may see what has exactly one home.
 */
@Global()
@Module({
  controllers: [PatientsController],
  providers: [
    PatientProfileService,
    // M-11 overrides this with a lookup over `consultations`. Until then it
    // answers no to every doctor, so the access rule fails closed.
  ],
  exports: [PatientProfileService],
})
export class PatientsModule {}
