import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { toCsv } from '../governance/csv';
import { DataDeletionService } from '../legal/data-deletion.service';
import { ComplianceError } from './compliance.errors';

export const RETENTION_DAYS_KEY = 'compliance.audit_retention_days';
/**
 * How long an audit entry is kept.
 *
 * Deliberately LONG. SRS 5.3 makes retention the client's to set, and the
 * default has to be the safe end of that: an entry deleted too early cannot be
 * recovered, while one kept too long is a storage cost and a config change.
 * Eight years is the common Indian medical-records expectation; the client's
 * counsel sets the real figure.
 */
export const DEFAULT_RETENTION_DAYS = 2920;

const RETENTION = z.number().int().min(365).max(7300);

export interface AuditQuery {
  actorType?: string;
  actorId?: string;
  /** The table or concept touched - `payment`, `clinical_record`, `app_config`. */
  entityType?: string;
  entityId?: string;
  consultationId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface AuditEntryView {
  id: string;
  actorType: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  consultationId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
}

/** What a deletion run actually did, per table. Written onto the request row. */
export interface DeletionOutcome {
  deleted: Record<string, number>;
  /** What was kept, and the ground for keeping it. */
  retained: Record<string, string>;
  failure?: string;
}

/**
 * M-21 Audit, Compliance and Data Rights. Owns NOTHING.
 *
 * `audit_log` is M-01's, because every module writes to it from its first
 * release. Retention is a value in `app_config`. Deletion evidence is columns
 * on M-03's request row. This module owns the BEHAVIOUR over all three: the
 * search, the retention sweep and the erasure run.
 *
 * *** THE LOG IS APPEND-ONLY, AND THIS MODULE DOES NOT BREAK THAT. ***
 * There is no method here that edits an entry, and the only one that removes
 * any is the retention sweep, which deletes by AGE and never by content. An
 * audit trail somebody can edit is not an audit trail - so "delete this
 * embarrassing entry" is not an operation that exists.
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly deletions: DataDeletionService,
  ) {}

  // -- Searching the trail (SRS 6.7) ----------------------------------------

  /**
   * FR-18's log search: by actor, by module and by date.
   *
   * *** VISIBILITY IS LIMITED BY PERMISSION LEVEL. ***
   *
   * `super_admin` reads everything. Everyone else reads the entity types their
   * own work covers, because an audit log is a record of what people did and a
   * content editor has no business reading the trail of a clinical record.
   * That is not secrecy - it is the same least-privilege rule the rest of the
   * panel runs on, applied to the one table that describes all of it.
   *
   * *** SEARCHING THE LOG IS ITSELF AUDITED. *** Reading who saw what is a
   * privileged act, and a trail that does not record its own readers cannot
   * answer the question it exists for.
   */
  async search(actor: AuthenticatedActor, query: AuditQuery = {}): Promise<AuditEntryView[]> {
    const allowed = this.readableEntityTypes(actor);

    const where: Prisma.AuditLogWhereInput = {
      ...(allowed ? { entityType: { in: allowed } } : {}),
      ...(query.actorType ? { actorType: query.actorType as never } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.consultationId ? { consultationId: query.consultationId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 200, 1000),
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'read',
      entityType: 'audit_log',
      // The QUERY, not the results. Recording what was asked is what makes a
      // later question answerable; copying the answers would double the log
      // every time somebody looked at it.
      entityId: 'search',
      metadata: {
        query: { ...query, from: query.from?.toISOString(), to: query.to?.toISOString() },
        returned: rows.length,
      },
    });

    return rows.map(shape);
  }

  /** The same search, as a file. SRS 6.7's export. */
  async exportCsv(actor: AuthenticatedActor, query: AuditQuery = {}): Promise<string> {
    const entries = await this.search(actor, { ...query, limit: 10_000 });
    return toCsv(
      [
        'at',
        'actor_type',
        'actor_id',
        'action',
        'entity_type',
        'entity_id',
        'consultation_id',
        'ip',
        'metadata',
      ],
      entries.map((entry) => [
        entry.createdAt,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.consultationId,
        entry.ipAddress,
        entry.metadata,
      ]),
    );
  }

  /**
   * M-21's completion criterion, as a query: everything that ever touched one
   * consultation, in order.
   *
   * "A clinical record read, a refund and a configuration change each leave a
   * complete entry with actor, target and time" - this is where somebody checks
   * that, and it is the view a complaint or a subject access request is
   * answered from.
   */
  async trailFor(consultationId: string, actor: AuthenticatedActor): Promise<AuditEntryView[]> {
    assertPermission(actor, 'operations', 'clinical_governance');
    const rows = await this.prisma.auditLog.findMany({
      where: { consultationId },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'read',
      entityType: 'audit_log',
      entityId: consultationId,
      consultationId,
      metadata: { trail: true, returned: rows.length },
    });
    return rows.map(shape);
  }

  // -- Retention (SRS 5.3) --------------------------------------------------

  /** What the client has set, or the conservative default. */
  async retentionDays(): Promise<number> {
    return (await this.config.get(RETENTION_DAYS_KEY, RETENTION)) ?? DEFAULT_RETENTION_DAYS;
  }

  /**
   * Delete audit entries older than the retention period.
   *
   * *** BY AGE, AND ONLY BY AGE. *** There is no filter on this: it cannot be
   * pointed at an actor, an entity or a date range of somebody's choosing. A
   * retention sweep that could be aimed is a way to erase a specific
   * inconvenient entry, which is exactly what an audit log exists to prevent.
   *
   * Returns the count rather than doing it silently, and writes its own entry -
   * so the trail records that a slice of the trail was retired, and when.
   */
  async applyRetention(actor: AuthenticatedActor, now = new Date()): Promise<{ deleted: number }> {
    // Super admin only. Retention is a legal decision, not an operational one.
    assertPermission(actor, 'super_admin');
    return this.retire({ type: 'admin', id: actor.id }, now);
  }

  /**
   * The same sweep, run by the SCHEDULE rather than by a person.
   *
   * A separate entry point rather than an actor-shaped fake, so the audit entry
   * says `system` truthfully. "Who deleted these entries" must not answer with
   * the name of whichever admin happened to be configured - nobody clicked it,
   * and a trail that implies somebody did is worse than one that says nothing.
   */
  async applyRetentionAsSystem(now = new Date()): Promise<{ deleted: number }> {
    return this.retire({ type: 'system' }, now);
  }

  private async retire(
    by: { type: 'admin'; id: string } | { type: 'system' },
    now: Date,
  ): Promise<{ deleted: number }> {
    const days = await this.retentionDays();
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - days);

    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    await this.audit.record({
      actorType: by.type,
      actorId: by.type === 'admin' ? by.id : null,
      action: 'delete',
      entityType: 'audit_log',
      entityId: 'retention',
      metadata: {
        retentionDays: days,
        cutoff: cutoff.toISOString(),
        deleted: count,
        // Whether a person asked for this or the clock did. The difference is
        // the whole question a later audit of the audit would be asking.
        scheduled: by.type === 'system',
      },
    });

    this.logger.log({ deleted: count, cutoff: cutoff.toISOString() }, 'Applied audit retention');
    return { deleted: count };
  }

  // -- Data rights (SRS 6.4) ------------------------------------------------

  /**
   * *** EXECUTE AN APPROVED DELETION REQUEST. ***
   *
   * M-03 takes the request and an admin approves it; this runs it and hands the
   * outcome back to M-03 to record. M-03's own comment says so: "M-21 owns the
   * run; this is where its result lands."
   *
   * The erasure itself is almost entirely the DATABASE's work. `patients` is
   * the root, and the foreign keys decide what follows: consultations, files,
   * check-ins, alerts, complaints and participants all CASCADE, because each is
   * a record of that person's own care. What does NOT cascade is deliberate and
   * is reported as retained rather than quietly left behind.
   */
  async executeDeletion(
    requestId: string,
    actor: AuthenticatedActor,
  ): Promise<{ requestId: string; outcome: DeletionOutcome }> {
    assertPermission(actor, 'super_admin');

    const request = await this.prisma.dataDeletionRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) {
      throw new AppException(
        ComplianceError.REQUEST_NOT_FOUND,
        'Deletion request not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (request.status !== 'approved') {
      throw new AppException(
        ComplianceError.NOT_APPROVED,
        'Only an approved request can be executed.',
        HttpStatus.CONFLICT,
        { status: request.status },
      );
    }

    // Counted BEFORE the delete, because afterwards there is nothing to count.
    // This is the evidence the outcome record is made of.
    const patientId = request.patientId;
    const [consultations, files, complaints, checkins] = await Promise.all([
      this.prisma.consultation.count({ where: { patientId } }),
      this.prisma.patientFile.count({ where: { patientId } }),
      this.prisma.complaint.count({ where: { patientId } }),
      this.prisma.checkinResponse.count({ where: { consultation: { patientId } } }),
    ]);

    let outcome: DeletionOutcome;
    let succeeded = true;
    try {
      // One statement. The cascade does the rest, which is the point of having
      // spent the schema work on getting those `ON DELETE` rules right.
      await this.prisma.patient.delete({ where: { id: patientId } });

      outcome = {
        deleted: {
          patients: 1,
          consultations,
          patient_files: files,
          complaints,
          checkin_responses: checkins,
        },
        retained: {
          // Named explicitly rather than left implicit. A subject access
          // request asks what was kept, and "nothing, probably" is not an answer.
          payments:
            'Financial records are retained under statutory accounting obligations. They reference the consultation, not the person.',
          audit_log:
            'The trail of what was done to this account is retained for the configured retention period, so the erasure itself remains provable.',
          clarification_cases:
            'Already de-identified: the case holds no patient reference, and its link to the consultation is cleared by the erasure.',
        },
      };
    } catch (error) {
      // A failure writes its reason into the SAME record. M-03 has no separate
      // failure column for exactly this reason.
      succeeded = false;
      outcome = {
        deleted: {},
        retained: {},
        failure: error instanceof Error ? error.message : String(error),
      };
      this.logger.error({ err: error, requestId }, 'Deletion run failed');
    }

    await this.deletions.recordExecution(requestId, {
      succeeded,
      outcome: outcome as unknown as Prisma.InputJsonValue,
    });

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'delete',
      entityType: 'patient',
      // The patient id survives in the trail on purpose. Erasing the evidence
      // that an erasure happened would make the obligation unprovable, and SRS
      // 6.7 keeps the log for exactly that.
      entityId: patientId,
      metadata: { requestId, succeeded },
    });

    if (!succeeded) {
      throw new AppException(
        ComplianceError.DELETION_FAILED,
        'The erasure could not be completed. The reason is recorded against the request.',
        HttpStatus.INTERNAL_SERVER_ERROR,
        { requestId },
      );
    }
    return { requestId, outcome };
  }

  // -- Internals ------------------------------------------------------------

  /**
   * Which entity types this admin may read, or null for "all of them".
   *
   * The same least-privilege rule the rest of the panel runs on, applied to the
   * one table that describes all of it. A content editor reading the trail of a
   * clinical record would be a wider view of clinical activity than their own
   * screens give them.
   */
  private readableEntityTypes(actor: AuthenticatedActor): string[] | null {
    if (actor.type !== 'admin') {
      throw new AppException(
        ComplianceError.NOT_PERMITTED,
        'The audit log is readable from the admin panel only.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (actor.level === 'super_admin') return null;

    switch (actor.level) {
      case 'clinical_governance':
        return [...CLINICAL_ENTITIES, ...SHARED_ENTITIES];
      case 'care_coordinator':
        return [...SAFETY_ENTITIES, ...SHARED_ENTITIES];
      case 'finance':
        return [...FINANCE_ENTITIES, ...SHARED_ENTITIES];
      case 'operations':
        return [...OPERATIONS_ENTITIES, ...SHARED_ENTITIES];
      case 'content':
        return [...CONTENT_ENTITIES];
      default:
        throw new AppException(
          ComplianceError.NOT_PERMITTED,
          'Your admin role does not have access to the audit log.',
          HttpStatus.FORBIDDEN,
        );
    }
  }
}

/** Everything a consultation touches clinically. */
const CLINICAL_ENTITIES = [
  'clinical_record',
  'clarification_case',
  'consultation',
  'consultation_assignment',
  'safety_alert',
  'followup_assignment',
  'followup_pathway',
  'video_join_token',
  'video_webhook',
];

const SAFETY_ENTITIES = ['safety_alert', 'followup_assignment', 'consultation', 'complaint'];

const FINANCE_ENTITIES = ['payment', 'payment_webhook', 'consultation'];

const OPERATIONS_ENTITIES = [
  'consultation',
  'consultation_assignment',
  'consultation_decline',
  'complaint',
  'consultation_feedback',
  'doctor',
  'doctor_document',
  'clarification_case',
];

const CONTENT_ENTITIES = ['content_item', 'followup_pathway', 'legal_document', 'app_config'];

/** Readable by every level that reads the log at all. */
const SHARED_ENTITIES = ['app_config', 'service'];

function shape(row: {
  id: bigint | number | string;
  actorType: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  consultationId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
}): AuditEntryView {
  return {
    // A bigint, which JSON cannot carry. Stringified for the same reason
    // M-08's notification ids are.
    id: String(row.id),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    consultationId: row.consultationId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
  };
}
