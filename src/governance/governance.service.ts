import { Injectable, Logger } from '@nestjs/common';
import {
  ClarificationStatus,
  ComplaintStatus,
  ConsultationStatus,
  FollowupStatus,
  SafetyAlertType,
} from '@prisma/client';

import { AuthenticatedActor, assertPermission } from '../common/auth';
import { PrismaService } from '../database/prisma.service';
import { DoctorRegistryService } from '../doctors/doctor-registry.service';
import { toCsv } from './csv';

/**
 * A ceiling on an export. Large enough for a year of a launch-scale service,
 * small enough that one click cannot pull the whole database into memory.
 */
const EXPORT_LIMIT = 10_000;

/** FR-18.6's dashboard. Every figure is a COUNT of rows somebody else owns. */
export interface QualityDashboard {
  /** The window these figures cover. Null `from` means all time. */
  from: Date | null;
  to: Date;
  consultations: {
    completed: number;
    cancelled: number;
    noShow: number;
    /** Held but not yet written up. The pending-summaries queue, as a number. */
    awaitingDocumentation: number;
  };
  safety: {
    /** Open red flags. The queue a care coordinator works first. */
    openRedFlags: number;
    openAmber: number;
    openMissedCheckins: number;
    /** Everything unclosed, however it arrived. */
    openTotal: number;
  };
  followUp: {
    active: number;
    completed: number;
    checkinsSubmitted: number;
  };
  complaints: {
    open: number;
    inProgress: number;
    resolved: number;
    rejected: number;
  };
  clarifications: {
    awaitingAssignment: number;
    withAnExpert: number;
    closed: number;
  };
}

/** A row on a working queue. Deliberately thin: it is a worklist, not a record. */
export interface QueueItem {
  consultationId: string;
  referenceCode: string;
  doctorId: string | null;
  patientId: string;
  /** What the queue is sorted and chased by. */
  since: Date;
  detail?: string;
}

/** FR-18.6's reliability figures, per provider. */
export interface ProviderQuality {
  doctorId: string;
  fullName: string;
  acceptanceRate: number | null;
  noShowRate: number | null;
  caseSummaryCompletion: number | null;
  consultationsCompleted: number;
}

/**
 * M-20 Governance and Quality. Owns NOTHING.
 *
 * *** EVERY FIGURE IS READ FROM THE TABLE THAT OWNS IT. ***
 *
 * M-20's completion criterion is that every number on the dashboard reconciles
 * with the owning module's data, and the only way to guarantee that is to have
 * no numbers of its own. There are no counters here, no nightly rollup and no
 * summary table - a dashboard figure cannot disagree with its source because it
 * IS its source, counted at the moment it is asked for.
 *
 * That costs a handful of counts per dashboard load. It buys the one property
 * that matters for a control room: when an admin says "this says twelve" and a
 * clinician says "I can only find eleven", they are looking at the same rows.
 *
 * The reliability figures come through M-05's registry, which reads them
 * through the `DOCTOR_METRICS` port - so even those are not counted twice.
 */
@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly doctors: DoctorRegistryService,
  ) {}

  /**
   * FR-18.6. The whole dashboard in one call.
   *
   * Counted in parallel because they are independent, and counted against the
   * same `to` instant so two figures on one screen cannot come from two
   * different moments.
   */
  async dashboard(
    actor: AuthenticatedActor,
    window: { from?: Date; to?: Date } = {},
  ): Promise<QualityDashboard> {
    assertPermission(actor, 'operations', 'clinical_governance', 'care_coordinator');

    const to = window.to ?? new Date();
    const from = window.from ?? null;
    const created = from ? { gte: from, lte: to } : { lte: to };

    const [
      completed,
      cancelled,
      noShow,
      awaitingDocumentation,
      openRedFlags,
      openAmber,
      openMissedCheckins,
      openTotal,
      followupActive,
      followupCompleted,
      checkinsSubmitted,
      complaintsOpen,
      complaintsInProgress,
      complaintsResolved,
      complaintsRejected,
      clarAwaiting,
      clarWithExpert,
      clarClosed,
    ] = await Promise.all([
      this.prisma.consultation.count({
        where: { status: ConsultationStatus.completed, createdAt: created },
      }),
      this.prisma.consultation.count({
        where: { status: ConsultationStatus.cancelled, createdAt: created },
      }),
      this.prisma.consultation.count({
        where: { status: ConsultationStatus.no_show, createdAt: created },
      }),
      this.prisma.consultation.count({
        where: { status: ConsultationStatus.awaiting_documentation, createdAt: created },
      }),

      // Safety counts the OPEN ones regardless of the window: an unclosed red
      // flag from last month is still somebody's problem today, and a queue
      // that hides it behind a date filter is a queue that loses people.
      this.prisma.safetyAlert.count({
        where: { alertType: SafetyAlertType.red_flag, closedAt: null },
      }),
      this.prisma.safetyAlert.count({
        where: { alertType: SafetyAlertType.amber, closedAt: null },
      }),
      this.prisma.safetyAlert.count({
        where: { alertType: SafetyAlertType.missed_checkin, closedAt: null },
      }),
      this.prisma.safetyAlert.count({ where: { closedAt: null } }),

      this.prisma.consultation.count({ where: { followupStatus: FollowupStatus.active } }),
      this.prisma.consultation.count({
        where: { followupStatus: FollowupStatus.completed, updatedAt: created },
      }),
      this.prisma.checkinResponse.count({ where: { submittedAt: created } }),

      this.prisma.complaint.count({ where: { status: ComplaintStatus.open } }),
      this.prisma.complaint.count({ where: { status: ComplaintStatus.in_progress } }),
      this.prisma.complaint.count({
        where: { status: ComplaintStatus.resolved, resolvedAt: created },
      }),
      this.prisma.complaint.count({
        where: { status: ComplaintStatus.rejected, updatedAt: created },
      }),

      this.prisma.clarificationCase.count({ where: { status: ClarificationStatus.posted } }),
      this.prisma.clarificationCase.count({
        where: {
          status: {
            in: [
              ClarificationStatus.awaiting_response,
              ClarificationStatus.response_received,
              ClarificationStatus.clarification_asked,
            ],
          },
        },
      }),
      this.prisma.clarificationCase.count({
        where: { status: ClarificationStatus.closed, closedAt: created },
      }),
    ]);

    return {
      from,
      to,
      consultations: { completed, cancelled, noShow, awaitingDocumentation },
      safety: { openRedFlags, openAmber, openMissedCheckins, openTotal },
      followUp: {
        active: followupActive,
        completed: followupCompleted,
        checkinsSubmitted,
      },
      complaints: {
        open: complaintsOpen,
        inProgress: complaintsInProgress,
        resolved: complaintsResolved,
        rejected: complaintsRejected,
      },
      clarifications: {
        awaitingAssignment: clarAwaiting,
        withAnExpert: clarWithExpert,
        closed: clarClosed,
      },
    };
  }

  /**
   * FR-18.5's pending case summaries.
   *
   * A consultation that was held and has no FINALISED record. Ordered oldest
   * first, because the question this queue answers is "what has been waiting
   * longest", and a clinician's memory of a consultation is the thing that
   * decays.
   */
  async pendingCaseSummaries(actor: AuthenticatedActor, limit = 100): Promise<QueueItem[]> {
    assertPermission(actor, 'operations', 'clinical_governance', 'care_coordinator');

    const rows = await this.prisma.consultation.findMany({
      where: {
        status: ConsultationStatus.awaiting_documentation,
        // The record may exist as a DRAFT and still not count. M-15's freeze is
        // what makes a summary a summary.
        OR: [{ clinicalRecord: null }, { clinicalRecord: { finalisedAt: null } }],
      },
      select: {
        id: true,
        referenceCode: true,
        doctorId: true,
        patientId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: Math.min(limit, 200),
    });

    return rows.map((row) => ({
      consultationId: row.id,
      referenceCode: row.referenceCode,
      doctorId: row.doctorId,
      patientId: row.patientId,
      since: row.updatedAt,
    }));
  }

  /**
   * FR-18.6's reliability table.
   *
   * Read through M-05's registry rather than counted here, so the dashboard and
   * the provider's own profile show the same number. Two implementations of one
   * figure is two figures.
   */
  async providerQuality(actor: AuthenticatedActor, limit = 100): Promise<ProviderQuality[]> {
    assertPermission(actor, 'operations', 'clinical_governance');

    const doctors = await this.prisma.doctor.findMany({
      where: { verificationStatus: 'verified' },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
      take: Math.min(limit, 200),
    });

    // Sequential rather than parallel: this is an admin screen loaded rarely,
    // and firing three counts per provider at once across a hundred providers
    // is how a reporting query takes a production database down.
    const quality: ProviderQuality[] = [];
    for (const doctor of doctors) {
      const reliability = await this.doctors.reliabilityOf(doctor.id);
      quality.push({ doctorId: doctor.id, fullName: doctor.fullName, ...reliability });
    }
    return quality;
  }

  /**
   * FR-18.9's allocation oversight: which consultations were assigned to whom,
   * and ON WHAT BASIS.
   *
   * The basis is not on the consultation - M-11 records WHO on the row and WHY
   * in the audit log, because why is a record of a decision rather than an
   * attribute of the appointment. So this reads the audit entries, which is the
   * only place the answer exists.
   */
  async allocationDecisions(
    actor: AuthenticatedActor,
    filter: { consultationId?: string; limit?: number } = {},
  ): Promise<{ consultationId: string; at: Date; actorType: string; basis: unknown }[]> {
    assertPermission(actor, 'operations', 'clinical_governance');

    const entries = await this.prisma.auditLog.findMany({
      where: {
        entityType: { in: ['consultation_assignment', 'consultation_decline'] },
        ...(filter.consultationId ? { entityId: filter.consultationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 100, 200),
      select: { entityId: true, createdAt: true, actorType: true, metadata: true },
    });

    return entries.map((entry) => ({
      consultationId: entry.entityId,
      at: entry.createdAt,
      actorType: entry.actorType,
      basis: entry.metadata,
    }));
  }

  /**
   * FR-18.4 and FR-18.6's export.
   *
   * Four sheets, each a flat read of one owning module's rows. Nothing is
   * aggregated on the way out: an export is evidence, and an export that has
   * already done the arithmetic cannot be checked against anything.
   */
  async exportCsv(
    kind: 'consultations' | 'complaints' | 'feedback' | 'safety-alerts',
    actor: AuthenticatedActor,
  ): Promise<string> {
    assertPermission(actor, 'operations', 'clinical_governance');

    switch (kind) {
      case 'consultations': {
        const rows = await this.prisma.consultation.findMany({
          orderBy: { createdAt: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            referenceCode: true,
            status: true,
            mode: true,
            doctorId: true,
            specialtyId: true,
            scheduledStartAt: true,
            durationMinutes: true,
            createdAt: true,
          },
        });
        return toCsv(
          [
            'reference',
            'status',
            'mode',
            'doctor_id',
            'specialty_id',
            'starts_at',
            'minutes',
            'created_at',
          ],
          rows.map((r) => [
            r.referenceCode,
            r.status,
            r.mode,
            r.doctorId,
            r.specialtyId,
            r.scheduledStartAt,
            r.durationMinutes,
            r.createdAt,
          ]),
        );
      }

      case 'complaints': {
        const rows = await this.prisma.complaint.findMany({
          orderBy: { createdAt: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            referenceCode: true,
            category: true,
            subject: true,
            status: true,
            assignedToAdminId: true,
            resolvedAt: true,
            resolutionNote: true,
            createdAt: true,
          },
        });
        // The DESCRIPTION and the message thread are deliberately absent. A
        // complaint body is the patient's own words about a named clinician,
        // and an export is a file that gets emailed around.
        return toCsv(
          [
            'ticket',
            'category',
            'subject',
            'status',
            'assigned_to',
            'resolved_at',
            'resolution',
            'created_at',
          ],
          rows.map((r) => [
            r.referenceCode,
            r.category,
            r.subject,
            r.status,
            r.assignedToAdminId,
            r.resolvedAt,
            r.resolutionNote,
            r.createdAt,
          ]),
        );
      }

      case 'feedback': {
        const rows = await this.prisma.consultation.findMany({
          where: { feedbackRating: { not: null } },
          orderBy: { updatedAt: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            referenceCode: true,
            doctorId: true,
            feedbackRating: true,
            feedbackComment: true,
            scheduledStartAt: true,
          },
        });
        return toCsv(
          ['reference', 'doctor_id', 'rating', 'comment', 'consulted_at'],
          rows.map((r) => [
            r.referenceCode,
            r.doctorId,
            r.feedbackRating,
            r.feedbackComment,
            r.scheduledStartAt,
          ]),
        );
      }

      case 'safety-alerts': {
        const rows = await this.prisma.safetyAlert.findMany({
          orderBy: { createdAt: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            alertType: true,
            consultationId: true,
            reason: true,
            acknowledgedAt: true,
            closedAt: true,
            closingNote: true,
            createdAt: true,
          },
        });
        return toCsv(
          [
            'type',
            'consultation_id',
            'reason',
            'acknowledged_at',
            'closed_at',
            'closing_note',
            'raised_at',
          ],
          rows.map((r) => [
            r.alertType,
            r.consultationId,
            r.reason,
            r.acknowledgedAt,
            r.closedAt,
            r.closingNote,
            r.createdAt,
          ]),
        );
      }
    }
  }
}
