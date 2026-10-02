import { Injectable } from '@nestjs/common';
import { ConsultationStatus, InstantConsultancyOutcome } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';
import { DoctorMetrics, DoctorReliability } from '../doctors/doctor-metrics';
import { ConsultationAccess, ConsultationContext } from '../files/consultation-access';
import { PatientAssignment } from '../patients/patient-assignment';
import { BookedIntervals } from '../scheduling/booked-intervals';
import { Interval, addMinutes } from '../scheduling/intervals';
import { HOLDS_TIME } from './assignment.service';

/**
 * *** THE FOUR PORTS M-11 CLOSES. ***
 *
 * Four earlier modules each needed one question answered about `consultations`
 * and could not answer it, because this table did not exist. Each declared a
 * port and bound a deliberately CLOSED default - "no doctor is treating anyone",
 * "nothing is booked", "every rate is unknown" - so that a missing dependency
 * could never read as permission.
 *
 * This file is where those defaults are replaced. Nothing in M-04, M-05, M-07
 * or M-10 changes; they were written against the port and go on calling it.
 */

/**
 * M-07: the time a provider's diary already has something in it.
 *
 * The interval a booking occupies is NOT just its duration - a 30-minute
 * consultation with a 5-minute buffer occupies 35, because the buffer is time
 * the provider is not available to anyone else. M-07 said the implementation
 * owns that arithmetic, because it is the module holding the duration; this is
 * it.
 */
@Injectable()
export class ConsultationBookedIntervals implements BookedIntervals {
  constructor(private readonly prisma: PrismaService) {}

  async forDoctors(doctorIds: string[], from: Date, to: Date): Promise<Map<string, Interval[]>> {
    const byDoctor = new Map<string, Interval[]>(doctorIds.map((id) => [id, []]));
    if (doctorIds.length === 0) return byDoctor;

    const rows = await this.prisma.consultation.findMany({
      where: {
        doctorId: { in: doctorIds },
        // Only the statuses that actually hold time. A cancelled or expired
        // booking must free its slot immediately, which is the whole point of
        // releasing an abandoned checkout.
        status: { in: HOLDS_TIME },
        scheduledStartAt: { gte: addMinutes(from, -MAX_CONSULTATION_MINUTES), lt: to },
      },
      select: { doctorId: true, scheduledStartAt: true, durationMinutes: true },
    });

    const buffers = await this.prisma.doctor.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, bufferMinutes: true },
    });
    const bufferOf = new Map(buffers.map((row) => [row.id, row.bufferMinutes]));

    for (const row of rows) {
      if (!row.doctorId || !row.scheduledStartAt) continue;
      const occupied = row.durationMinutes + (bufferOf.get(row.doctorId) ?? 0);
      byDoctor.get(row.doctorId)?.push({
        startsAt: row.scheduledStartAt,
        endsAt: addMinutes(row.scheduledStartAt, occupied),
      });
    }
    return byDoctor;
  }
}

/**
 * M-10: who may open a patient's clinical files, and M-04: whether a doctor may
 * read a patient's profile at all. One question, asked by two modules.
 *
 * "Ever consulted", not "currently consulting". A patient's second appointment
 * with the same provider should not lose sight of the first, and a provider
 * writing up last week's consultation still needs the file they were sent.
 */
@Injectable()
export class ConsultationBackedAccess implements ConsultationAccess, PatientAssignment {
  constructor(private readonly prisma: PrismaService) {}

  async contextOf(consultationId: string): Promise<ConsultationContext | null> {
    const found = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { id: true, patientId: true, doctorId: true, status: true },
    });
    if (!found) return null;
    return {
      id: found.id,
      patientId: found.patientId,
      doctorId: found.doctorId,
      // Everything past the consultation itself counts as finished for M-10's
      // purpose: what it is deciding is whether a file has become part of a
      // record somebody relied on, and by any of these it has.
      isCompleted: SETTLED.includes(found.status),
    };
  }

  async isTreating(doctorId: string, patientId: string): Promise<boolean> {
    const consultations = await this.prisma.consultation.count({
      where: {
        doctorId,
        patientId,
        // A cancelled or expired booking is not a course of care. It would
        // otherwise be a way to reach any patient's record by booking and
        // immediately cancelling.
        status: { notIn: [ConsultationStatus.cancelled, ConsultationStatus.expired] },
      },
    });
    return consultations > 0;
  }

  /** M-04's wording for the same question. */
  isDoctorTreating(doctorId: string, patientId: string): Promise<boolean> {
    return this.isTreating(doctorId, patientId);
  }
}

/**
 * M-05: the reliability figures FR-18.6 shows, COUNTED rather than stored.
 *
 * M-05 was explicit that there are no counter columns on the doctor row,
 * because a counter and the rows it counts can disagree and only one of them is
 * the truth. This counts them.
 *
 * *** ALL THREE RATES ARE COUNTED NOW. *** Two of them were null until the
 * tables behind them existed: `acceptanceRate` needed M-13's
 * `instant_consultancy` and `caseSummaryCompletion` needed M-15's
 * `clinical_records.finalised_at`. This adapter is where the port's own
 * documentation says they belong - "the rows live in `consultations` (M-11) and
 * `instant_consultancy` (M-13), so this is a port those modules implement".
 *
 * Every rate is NULL rather than zero when its denominator is empty. A provider
 * offered nothing has not failed to accept anything, and a dashboard that shows
 * them 0% would be a false accusation - which matters, because FR-18.6's
 * figures are read as evidence about a named clinician.
 */
@Injectable()
export class ConsultationDoctorMetrics implements DoctorMetrics {
  constructor(private readonly prisma: PrismaService) {}

  async reliabilityOf(doctorId: string): Promise<DoctorReliability> {
    const [completed, noShow, attended, offered, accepted, summarised] = await Promise.all([
      this.prisma.consultation.count({
        where: { doctorId, status: ConsultationStatus.completed },
      }),
      this.prisma.consultation.count({
        where: { doctorId, status: ConsultationStatus.no_show },
      }),
      this.prisma.consultation.count({
        where: {
          doctorId,
          status: {
            in: [
              ConsultationStatus.completed,
              ConsultationStatus.no_show,
              ConsultationStatus.awaiting_documentation,
            ],
          },
        },
      }),
      // *** THE ACCEPTANCE DENOMINATOR EXCLUDES `superseded`. ***
      // A provider who was still deciding when somebody else accepted first did
      // not decline - counting that against them would penalise being on a busy
      // rota, and would make the fastest tapper look like the most reliable
      // clinician.
      this.prisma.instantConsultancy.count({
        where: {
          doctorId,
          outcome: {
            in: [
              InstantConsultancyOutcome.accepted,
              InstantConsultancyOutcome.declined,
              InstantConsultancyOutcome.timed_out,
            ],
          },
        },
      }),
      this.prisma.instantConsultancy.count({
        where: { doctorId, outcome: InstantConsultancyOutcome.accepted },
      }),
      // Completed consultations whose record was actually FINALISED. A draft is
      // not a case summary, which is the whole point of M-15's freeze.
      this.prisma.clinicalRecord.count({
        where: {
          finalisedAt: { not: null },
          consultation: { doctorId, status: ConsultationStatus.completed },
        },
      }),
    ]);

    return {
      acceptanceRate: offered === 0 ? null : accepted / offered,
      // Denominator is consultations that REACHED the appointment, not every
      // booking: one cancelled a week ahead says nothing about whether the
      // provider turns up.
      noShowRate: attended === 0 ? null : noShow / attended,
      // Out of COMPLETED consultations only. One still awaiting documentation
      // is not late paperwork - the doctor may be writing it now, and counting
      // it as a miss would make the figure worse the busier the clinic is.
      caseSummaryCompletion: completed === 0 ? null : summarised / completed,
      consultationsCompleted: completed,
    };
  }
}

/** Statuses at which a consultation has stopped being changeable by its patient. */
const SETTLED: ConsultationStatus[] = [
  ConsultationStatus.completed,
  ConsultationStatus.awaiting_documentation,
  ConsultationStatus.no_show,
];

/**
 * How far before the window to look for a booking that might still overlap it.
 * A consultation cannot be longer than this, so nothing earlier can reach in.
 */
const MAX_CONSULTATION_MINUTES = 240;
