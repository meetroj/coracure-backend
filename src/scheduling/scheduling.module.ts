import { Global, Module } from '@nestjs/common';

import { AvailabilityService } from './availability.service';
import { AdminSchedulingController, SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';

/**
 * M-07 Availability and Scheduling. Owns `doctor_availability`, and nothing
 * else - there is no slots table, because a bookable slot is a computation over
 * this table and the consultations that already occupy time.
 *
 * Global for the same reason M-05 is: from M-09 onwards every module that
 * places work asks this one when a provider is free. M-09 needs the soonest
 * time a pool can cover a service, M-11 filters candidates by FR-10.7's
 * remaining duration and calls `assertFree` before it writes a consultation,
 * and M-13 re-routes an instant request by the same rules.
 *
 * It DECLARES `BOOKED_INTERVALS` but no longer binds it: M-11 owns
 * `consultations`, so M-11 supplies the reader, exactly as M-06 supplies the
 * `SPECIALTY_CATALOGUE` that M-05 declares. Nothing in this module changed when
 * it did - which was the point of the port.
 */
@Global()
@Module({
  controllers: [SchedulingController, AdminSchedulingController],
  providers: [AvailabilityService, SchedulingService],
  exports: [AvailabilityService, SchedulingService],
})
export class SchedulingModule {}
