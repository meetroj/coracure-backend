import { HttpStatus, Injectable } from '@nestjs/common';
import { DataDeletionRequest, DeletionStatus, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { LegalError } from './legal.errors';

/** Still being handled, so a patient may not stack a second request behind it. */
const OPEN_STATUSES: DeletionStatus[] = ['requested', 'in_review', 'approved'];

/** An admin may still decide these. Once executed or rejected, the row is closed. */
const REVIEWABLE_STATUSES: DeletionStatus[] = ['requested', 'in_review'];

/**
 * The data-deletion workflow (FR-2.5, SRS 6.2), required by App Store
 * guideline 5.1.1(v) and the DPDP Act.
 *
 * M-03 owns the REQUEST and its evidence. M-21 owns the execution that fills
 * `execution_outcome` in, which is why `recordExecution` takes the outcome
 * rather than performing the deletion itself.
 *
 * The request row deliberately outlives the data it describes: it is the proof
 * that a deletion was asked for, decided and carried out.
 */
@Injectable()
export class DataDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** A patient asks for their data to be deleted. */
  async request(
    patientId: string,
    reason: string | undefined,
    context: { ipAddress?: string | null },
  ): Promise<DataDeletionRequest> {
    const open = await this.prisma.dataDeletionRequest.findFirst({
      where: { patientId, status: { in: OPEN_STATUSES } },
      select: { id: true, status: true },
    });
    if (open) {
      throw new AppException(
        LegalError.DELETION_REQUEST_IN_PROGRESS,
        'You already have a deletion request being handled.',
        HttpStatus.CONFLICT,
        { requestId: open.id, status: open.status },
      );
    }

    const created = await this.prisma.dataDeletionRequest.create({
      data: { patientId, reason: reason ?? null },
    });

    await this.audit.record({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: 'data_deletion_request',
      entityId: created.id,
      ipAddress: context.ipAddress,
    });
    return created;
  }

  /** What the patient sees of their own requests. */
  listForPatient(patientId: string): Promise<DataDeletionRequest[]> {
    return this.prisma.dataDeletionRequest.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The admin queue. Oldest first: a deletion request is a clock the client is on. */
  listForReview(status?: DeletionStatus): Promise<DataDeletionRequest[]> {
    return this.prisma.dataDeletionRequest.findMany({
      where: status ? { status } : { status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * An admin decides. `approved` means the execution in M-21 may run; it does
   * NOT mean anything has been deleted yet - `executed_at` says that.
   */
  async review(
    requestId: string,
    decision: { status: Extract<DeletionStatus, 'in_review' | 'approved' | 'rejected'>; note?: string },
    actor: AuthenticatedActor,
  ): Promise<DataDeletionRequest> {
    const request = await this.find(requestId);
    if (!REVIEWABLE_STATUSES.includes(request.status)) {
      throw new AppException(
        LegalError.DELETION_REQUEST_NOT_PENDING,
        `This request is already ${request.status} and cannot be reviewed again.`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.dataDeletionRequest.update({
      where: { id: requestId },
      data: {
        status: decision.status,
        reviewedByAdminId: actor.id,
        reviewedAt: new Date(),
        reviewNote: decision.note ?? null,
      },
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'update',
      entityType: 'data_deletion_request',
      entityId: requestId,
      metadata: { from: request.status, to: decision.status, note: decision.note ?? null },
    });
    return updated;
  }

  /**
   * Records what an execution run actually did. Written ONCE - per-table counts
   * deleted or anonymised, what was lawfully retained and on what ground, or
   * why the run failed. A failure writes its reason into the same record, which
   * is why there is no separate `failure_reason` column.
   *
   * M-21 owns the run; this is where its result lands.
   */
  async recordExecution(
    requestId: string,
    result: { succeeded: boolean; outcome: Prisma.InputJsonValue },
  ): Promise<DataDeletionRequest> {
    const request = await this.find(requestId);
    if (request.status !== 'approved') {
      throw new AppException(
        LegalError.DELETION_REQUEST_NOT_PENDING,
        'Only an approved request can be executed.',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.dataDeletionRequest.update({
      where: { id: requestId },
      data: {
        status: result.succeeded ? 'executed' : 'failed',
        executionOutcome: result.outcome,
        executedAt: new Date(),
      },
    });

    await this.audit.record({
      actorType: 'system',
      action: 'delete',
      entityType: 'data_deletion_request',
      entityId: requestId,
      metadata: { succeeded: result.succeeded },
    });
    return updated;
  }

  private async find(id: string): Promise<DataDeletionRequest> {
    const request = await this.prisma.dataDeletionRequest.findUnique({ where: { id } });
    if (!request) {
      throw new AppException('NOT_FOUND', 'That deletion request does not exist.', HttpStatus.NOT_FOUND);
    }
    return request;
  }
}
