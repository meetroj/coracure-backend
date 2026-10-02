import { Global, Module, OnModuleInit } from '@nestjs/common';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { DOCTOR_METRICS } from '../doctors/doctor-metrics';
import { CONSULTATION_ACCESS } from '../files/consultation-access';
import { PATIENT_ASSIGNMENT } from '../patients/patient-assignment';
import { BOOKED_INTERVALS } from '../scheduling/booked-intervals';
import { AssignmentService } from './assignment.service';
import {
  ConsultationBackedAccess,
  ConsultationBookedIntervals,
  ConsultationDoctorMetrics,
} from './booking.adapters';
import {
  AdminBookingController,
  DoctorBookingController,
  PatientBookingController,
} from './booking.controller';
import { BookingService, DEFAULT_HOLD_MINUTES, HOLD_MINUTES_KEY } from './booking.service';
import {
  CONSULT_REMINDER_LEAD_MINUTES_KEY,
  ConsultReminderSweeperService,
  DEFAULT_CONSULT_REMINDER_LEAD_MINUTES,
} from './consult-reminder-sweeper.service';
import { HoldSweeperService } from './hold-sweeper.service';

/**
 * M-11 Booking. Owns `consultations` - THE SPINE.
 *
 * *** THIS IS THE MODULE THAT CLOSES THE PORTS. *** Four earlier modules each
 * declared one and bound a closed default, because the answer lived in a table
 * that did not exist:
 *
 *   M-04  PATIENT_ASSIGNMENT   is this doctor treating this patient?
 *   M-05  DOCTOR_METRICS       the reliability figures, counted not stored
 *   M-07  BOOKED_INTERVALS     what time is already taken
 *   M-10  CONSULTATION_ACCESS  who may open a patient's files
 *
 * Binding them here is what turns four modules from "correct but closed" into
 * working, without a line changing inside any of them. `ConsultationBackedAccess`
 * answers two of the four, because M-04 and M-10 are asking the same question in
 * different words.
 *
 * Global because everything after it hangs off `consultations.id`: M-12 bills
 * one, M-14 opens a room for one, M-15 documents one, M-16 follows one up.
 */
@Global()
@Module({
  controllers: [PatientBookingController, DoctorBookingController, AdminBookingController],
  providers: [
    BookingService,
    AssignmentService,
    HoldSweeperService,
    ConsultReminderSweeperService,
    { provide: BOOKED_INTERVALS, useClass: ConsultationBookedIntervals },
    { provide: CONSULTATION_ACCESS, useClass: ConsultationBackedAccess },
    { provide: PATIENT_ASSIGNMENT, useClass: ConsultationBackedAccess },
    { provide: DOCTOR_METRICS, useClass: ConsultationDoctorMetrics },
  ],
  // *** EVERY BOUND TOKEN IS EXPORTED. *** A @Global() module shares only what
  // it exports, so a port bound here but not listed would leave the module that
  // declared it unable to resolve its own dependency.
  exports: [
    BookingService,
    AssignmentService,
    BOOKED_INTERVALS,
    CONSULTATION_ACCESS,
    PATIENT_ASSIGNMENT,
    DOCTOR_METRICS,
  ],
})
export class BookingModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /** How long a checkout may hold a slot (FR-6.2), as an admin-editable value. */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: HOLD_MINUTES_KEY,
        value: DEFAULT_HOLD_MINUTES,
        description:
          'Minutes a slot is held during checkout before the sweep releases it (FR-6.2). Long enough to finish a UPI payment, short enough not to park a provider’s slot.',
        schema: z.number().int().min(1).max(120),
        editableBy: ['operations'],
      },
      {
        key: CONSULT_REMINDER_LEAD_MINUTES_KEY,
        value: DEFAULT_CONSULT_REMINDER_LEAD_MINUTES,
        description:
          'Minutes before a scheduled consultation that the reminder notification (FR-16.1) goes out.',
        schema: z.number().int().min(5).max(180),
        editableBy: ['operations'],
      },
    ]);
  }
}
