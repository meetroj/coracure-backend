import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Gender, Prisma, SafetyAlert, SafetyAlertType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { NotificationCode } from '../notifications/notification-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { ageFrom, initialsOf } from '../patients/date-of-birth';
import { FollowupError } from './followup.errors';

/** What a doctor or an admin sees on the queue. */
export interface AlertRecord {
  id: string;
  alertType: SafetyAlertType;
  consultationId: string;
  /** The id the alert is ABOUT. Was missing, leaving nothing for the doctor
   * app to resolve the masked identity below (or `GET patients/:id/card`) from. */
  patientId: string;
  /** FR-9.2's masked identity, inlined so the alert queue needs no round trip per row. */
  patientInitials: string | null;
  patientAge: number | null;
  patientGender: Gender;
  checkinResponseId: string | null;
  reason: string | null;
  /** Read from the two timestamps. There is no status column. */
  state: 'open' | 'acknowledged' | 'closed';
  acknowledgedAt: Date | null;
  acknowledgedBy: { type: 'admin' | 'doctor'; id: string } | null;
  closedAt: Date | null;
  closingNote: string | null;
  createdAt: Date;
}

export interface RaiseAlert {
  alertType: SafetyAlertType;
  consultationId: string;
  checkinResponseId?: string | null;
  reason?: string | null;
  /** The name the notification copy uses. Never a diagnosis, never an answer. */
  patientName?: string;
  /** Only for `missed_checkin`, whose copy quotes a number. */
  count?: number;
}

/** The admin levels a safety alert is addressed to (FR-13.4). */
const ALERTED_ADMIN_LEVELS = ['care_coordinator', 'clinical_governance'] as const;

/** The notification each alert type sends. `followup_due` notifies nobody. */
const NOTIFICATION_FOR: Partial<Record<SafetyAlertType, NotificationCode>> = {
  red_flag: 'red_flag_alert',
  amber: 'amber_alert',
  missed_checkin: 'missed_checkin',
  // A troubling side effect is a red-flag finding and rides the red copy: the
  // urgency is the same and there is no separate screen for it.
  medication_side_effect: 'red_flag_alert',
};

/**
 * M-16's safety alerts. Owns `safety_alerts`.
 *
 * *** THE ALERT IS THE RECORD, THE NOTIFICATION IS THE POSTMAN. ***
 *
 * The row is written first and always. Delivery is attempted afterwards and its
 * failure is logged, never thrown: a push that does not arrive is bad, but an
 * unrecorded safety finding because a push failed is unforgivable, and the
 * governance queue is what a care coordinator actually works from.
 *
 * *** OPEN, ACKNOWLEDGED AND CLOSED ARE TIMESTAMPS. *** `acknowledged_at` and
 * `closed_at` carry the whole lifecycle. There is no status column beside them
 * that could disagree, and a CHECK refuses an alert closed without having been
 * acknowledged - nobody closes a safety alert they did not look at.
 */
@Injectable()
export class SafetyAlertsService {
  private readonly logger = new Logger(SafetyAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Raise one, and tell the people who need to know.
   *
   * FR-13.4: a red status alerts BOTH the treating doctor and admins at
   * care-coordinator or clinical-governance level. Both, not either - the
   * doctor may be with another patient, and the whole point of a care
   * coordinator is that somebody is watching when the clinician cannot be.
   */
  async raise(input: RaiseAlert): Promise<AlertRecord> {
    const alert = await this.prisma.safetyAlert.create({
      data: {
        alertType: input.alertType,
        consultationId: input.consultationId,
        checkinResponseId: input.checkinResponseId ?? null,
        reason: input.reason?.slice(0, 255) ?? null,
      },
    });

    await this.audit.record({
      actorType: 'system',
      action: 'create',
      entityType: 'safety_alert',
      entityId: alert.id,
      consultationId: input.consultationId,
      metadata: { alertType: input.alertType, reason: alert.reason },
    });

    await this.announce(alert, input);
    return this.withPatientCard(alert);
  }

  /**
   * Delivery. Every failure is caught: this is the postman, not the record.
   *
   * The copy carries the patient's name and nothing else - no answer, no
   * category, no diagnosis. A lock-screen preview is read by whoever is holding
   * the phone (FR-16.2), and "a check-in needs review" is enough to make
   * somebody open the app. What it was is in the app, behind authentication.
   */
  private async announce(alert: SafetyAlert, input: RaiseAlert): Promise<void> {
    const code = NOTIFICATION_FOR[input.alertType];
    if (!code) return;

    const variables: Record<string, string> = {
      patientName: input.patientName ?? 'A patient',
      ...(input.count !== undefined ? { count: String(input.count) } : {}),
    };

    const consultation = await this.prisma.consultation.findUnique({
      where: { id: input.consultationId },
      select: { doctorId: true },
    });

    try {
      if (consultation?.doctorId) {
        await this.notifications.notify({
          code,
          to: { doctorId: consultation.doctorId },
          variables,
          consultationId: input.consultationId,
          deepLink: { screen: 'safety_alert', alertId: alert.id },
        });
      }
      // ONE call for both levels. A super admin holds every level, so two calls
      // would send them the same alert twice.
      await this.notifications.notifyAdmins([...ALERTED_ADMIN_LEVELS], {
        code,
        variables,
        consultationId: input.consultationId,
        deepLink: { screen: 'safety_alert', alertId: alert.id },
      });
    } catch (error) {
      // The row is already written and the queue already shows it. Losing the
      // push is a degraded alert; losing the alert would be a lost finding.
      this.logger.error(
        { err: error, alertId: alert.id, alertType: input.alertType },
        'Raised the safety alert but could not deliver every notification',
      );
    }
  }

  /**
   * FR-18.5's governance queue, and FR-9.8's per-patient list for the doctor.
   *
   * Open alerts first and oldest first within that, because the question this
   * screen answers is "what has nobody dealt with, and for how long".
   */
  async list(
    actor: AuthenticatedActor,
    filter: { openOnly?: boolean; alertType?: SafetyAlertType; limit?: number } = {},
  ): Promise<AlertRecord[]> {
    const where: Prisma.SafetyAlertWhereInput = {
      ...(filter.openOnly === false ? {} : { closedAt: null }),
      ...(filter.alertType ? { alertType: filter.alertType } : {}),
    };

    if (actor.type === 'doctor') {
      // A doctor sees the alerts on their OWN patients and nobody else's.
      where.consultation = { doctorId: actor.id };
    } else {
      assertPermission(actor, 'care_coordinator', 'clinical_governance', 'operations');
    }

    const rows = await this.prisma.safetyAlert.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }],
      take: Math.min(filter.limit ?? 100, 200),
    });
    return this.withPatientCards(rows);
  }

  /**
   * Somebody has taken responsibility for this alert.
   *
   * Recording WHO is the point: a safety alert that was seen and judged not to
   * need action is a clinical decision, and the person who made it has to be
   * named. A CHECK refuses an acknowledgement with no acknowledger and refuses
   * two at once.
   *
   * Idempotent in the useful direction: acknowledging an already-acknowledged
   * alert leaves the FIRST acknowledger in place, because they are the one who
   * actually judged it.
   */
  async acknowledge(alertId: string, actor: AuthenticatedActor): Promise<AlertRecord> {
    const alert = await this.require(alertId, actor);
    if (alert.acknowledgedAt) return this.withPatientCard(alert);

    const updated = await this.prisma.safetyAlert.update({
      where: { id: alertId },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedByDoctorId: actor.type === 'doctor' ? actor.id : null,
        acknowledgedByAdminId: actor.type === 'admin' ? actor.id : null,
      },
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'safety_alert',
      entityId: alertId,
      consultationId: alert.consultationId,
      metadata: { acknowledged: true, alertType: alert.alertType },
    });
    return this.withPatientCard(updated);
  }

  /**
   * Done with. The closing note says what was done, and is the answer to "what
   * happened about this" months later.
   *
   * An unacknowledged alert cannot be closed. The database refuses it too; this
   * says so in words rather than as a constraint violation.
   */
  async close(
    alertId: string,
    closingNote: string,
    actor: AuthenticatedActor,
  ): Promise<AlertRecord> {
    const alert = await this.require(alertId, actor);
    if (!alert.acknowledgedAt) {
      throw new AppException(
        FollowupError.ALERT_NOT_ACKNOWLEDGED,
        'Acknowledge this alert before closing it, so it is on record who reviewed it.',
        HttpStatus.CONFLICT,
      );
    }
    if (alert.closedAt) return this.withPatientCard(alert);

    const updated = await this.prisma.safetyAlert.update({
      where: { id: alertId },
      data: { closedAt: new Date(), closingNote: closingNote.trim() },
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'safety_alert',
      entityId: alertId,
      consultationId: alert.consultationId,
      metadata: { closed: true, alertType: alert.alertType },
    });
    return this.withPatientCard(updated);
  }

  /** One alert's masked patient identity, joined through its consultation. */
  private async withPatientCard(alert: SafetyAlert): Promise<AlertRecord> {
    const [record] = await this.withPatientCards([alert]);
    return record;
  }

  /** Batched: the queue reads every open alert at once, not row by row. */
  private async withPatientCards(alerts: SafetyAlert[]): Promise<AlertRecord[]> {
    if (alerts.length === 0) return [];
    const consultations = await this.prisma.consultation.findMany({
      where: { id: { in: [...new Set(alerts.map((alert) => alert.consultationId))] } },
      select: {
        id: true,
        patientId: true,
        patient: { select: { fullName: true, dateOfBirth: true, gender: true } },
      },
    });
    const byConsultation = new Map(consultations.map((row) => [row.id, row]));
    return alerts.map((alert) => {
      const consultation = byConsultation.get(alert.consultationId);
      return shape(alert, {
        patientId: consultation?.patientId ?? '',
        patientInitials: initialsOf(consultation?.patient.fullName ?? null),
        patientAge: consultation?.patient.dateOfBirth
          ? ageFrom(consultation.patient.dateOfBirth)
          : null,
        patientGender: consultation?.patient.gender ?? Gender.undisclosed,
      });
    });
  }

  /** One alert's full detail. Same access rule as list/acknowledge/close. */
  async getOne(alertId: string, actor: AuthenticatedActor): Promise<AlertRecord> {
    return this.withPatientCard(await this.require(alertId, actor));
  }

  /** The treating doctor, or an admin at a level that handles alerts. */
  private async require(alertId: string, actor: AuthenticatedActor): Promise<SafetyAlert> {
    const alert = await this.prisma.safetyAlert.findUnique({
      where: { id: alertId },
      include: { consultation: { select: { doctorId: true } } },
    });
    if (!alert) throw alertNotFound();

    if (actor.type === 'doctor') {
      if (alert.consultation.doctorId !== actor.id) throw alertNotFound();
    } else if (actor.type === 'admin') {
      assertPermission(actor, 'care_coordinator', 'clinical_governance', 'operations');
    } else {
      // A patient never sees the alert their own check-in raised. They are
      // shown emergency guidance instead, which is what SRS 6.3 asks for -
      // telling somebody in crisis that they have been flagged is not care.
      throw alertNotFound();
    }
    return alert;
  }
}

function shape(
  row: SafetyAlert,
  patientCard: {
    patientId: string;
    patientInitials: string | null;
    patientAge: number | null;
    patientGender: Gender;
  },
): AlertRecord {
  return {
    id: row.id,
    alertType: row.alertType,
    consultationId: row.consultationId,
    ...patientCard,
    checkinResponseId: row.checkinResponseId,
    reason: row.reason,
    state: row.closedAt ? 'closed' : row.acknowledgedAt ? 'acknowledged' : 'open',
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedBy: row.acknowledgedByDoctorId
      ? { type: 'doctor', id: row.acknowledgedByDoctorId }
      : row.acknowledgedByAdminId
        ? { type: 'admin', id: row.acknowledgedByAdminId }
        : null,
    closedAt: row.closedAt,
    closingNote: row.closingNote,
    createdAt: row.createdAt,
  };
}

function alertNotFound(): AppException {
  return new AppException(FollowupError.ALERT_NOT_FOUND, 'Alert not found.', HttpStatus.NOT_FOUND);
}
