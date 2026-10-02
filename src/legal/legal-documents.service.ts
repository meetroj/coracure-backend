import { HttpStatus, Injectable } from '@nestjs/common';
import { LegalDocument, LegalDocumentType, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { LegalError } from './legal.errors';

/** What the app shows. The body is large, so listings leave it out. */
export type LegalDocumentSummary = Omit<LegalDocument, 'body'>;

const SUMMARY = {
  id: true,
  documentType: true,
  version: true,
  title: true,
  isCurrent: true,
  createdAt: true,
} satisfies Prisma.LegalDocumentSelect;

/**
 * The legal copy the app serves (FR-2.4) and the versions consent is pinned to.
 *
 * A version is a ROW. A document anyone has accepted is never edited, because
 * a `consents` row must always be able to show exactly what its holder agreed
 * to. Publishing therefore only ever inserts - the sole mutation in this
 * service is moving `is_current`, and a partial unique index keeps that to one
 * row per type.
 */
@Injectable()
export class LegalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every current document, for the in-app legal section. */
  listCurrent(): Promise<LegalDocumentSummary[]> {
    return this.prisma.legalDocument.findMany({
      where: { isCurrent: true },
      select: SUMMARY,
      orderBy: { documentType: 'asc' },
    });
  }

  /** The full text of the current version of one type, which is what the app renders. */
  async getCurrent(documentType: LegalDocumentType): Promise<LegalDocument> {
    const document = await this.prisma.legalDocument.findFirst({
      where: { documentType, isCurrent: true },
    });
    if (!document) {
      throw new AppException(
        LegalError.DOCUMENT_NOT_PUBLISHED,
        'That document has not been published yet.',
        HttpStatus.NOT_FOUND,
      );
    }
    return document;
  }

  /** The full version history of one type, newest first. Admin panel only. */
  listVersions(documentType: LegalDocumentType): Promise<LegalDocumentSummary[]> {
    return this.prisma.legalDocument.findMany({
      where: { documentType },
      select: SUMMARY,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Publishes a new version: one INSERT, and the previous current row demoted
   * in the SAME transaction. Nothing is edited and nothing is deleted, so
   * every consent ever given still resolves to the exact text accepted.
   */
  async publish(
    input: { documentType: LegalDocumentType; version: string; title: string; body: string },
    actor: AuthenticatedActor,
  ): Promise<LegalDocumentSummary> {
    const duplicate = await this.prisma.legalDocument.findUnique({
      where: { documentType_version: { documentType: input.documentType, version: input.version } },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppException(
        LegalError.VERSION_ALREADY_EXISTS,
        `Version "${input.version}" of that document already exists. Publish a new version number - an accepted version is never rewritten.`,
        HttpStatus.CONFLICT,
      );
    }

    const published = await this.prisma.$transaction(async (tx) => {
      // Demote first: the partial unique index allows only one current row per
      // type, so inserting before demoting would collide.
      await tx.legalDocument.updateMany({
        where: { documentType: input.documentType, isCurrent: true },
        data: { isCurrent: false },
      });
      return tx.legalDocument.create({
        data: { ...input, isCurrent: true },
        select: SUMMARY,
      });
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'create',
      entityType: 'legal_document',
      entityId: published.id,
      metadata: { documentType: input.documentType, version: input.version },
    });
    return published;
  }
}
