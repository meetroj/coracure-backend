import { HttpStatus, Injectable } from '@nestjs/common';
import { Consent, LegalDocumentType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { LegalError } from './legal.errors';
import { LegalDocumentsService } from './legal-documents.service';

/** What was accepted, and which version of it. */
export interface AcceptedConsent {
  documentType: LegalDocumentType;
  legalDocumentId: string;
  version: string;
  acceptedAt: Date;
}

/**
 * The evidence that somebody accepted a specific version of a specific
 * document (FR-2.3). Append-only: a row here is never updated and never
 * deleted, because it is what the platform would produce if asked to prove
 * what a person agreed to and when.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: LegalDocumentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records acceptance of the CURRENT version of a document type.
   *
   * The client names a type, never a document id: it must not be able to
   * accept a superseded version, and it should not have to know version
   * numbers at all. Accepting twice is a no-op rather than an error - a
   * retried request must not be a failure, and the unique index would refuse
   * the second row anyway.
   */
  async accept(
    actor: AuthenticatedActor,
    documentType: LegalDocumentType,
    context: { ipAddress?: string | null },
  ): Promise<AcceptedConsent> {
    const document = await this.documents.getCurrent(documentType);
    const subject = subjectOf(actor);

    const existing = await this.prisma.consent.findFirst({
      where: { ...subject, legalDocumentId: document.id },
    });
    if (existing) return shape(existing, document.version);

    const consent = await this.prisma.consent.create({
      data: {
        ...subject,
        legalDocumentId: document.id,
        // Denormalised, and a composite foreign key makes it impossible for
        // this to disagree with the document it points at.
        documentType: document.documentType,
        // The one IP kept outside audit_log: legal evidence, not a login fact.
        ipAddress: context.ipAddress ?? null,
      },
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'create',
      entityType: 'consent',
      entityId: consent.id,
      metadata: { documentType, version: document.version },
      ipAddress: context.ipAddress,
    });
    return shape(consent, document.version);
  }

  /** Everything this person has accepted, newest first. */
  async listFor(actor: AuthenticatedActor): Promise<AcceptedConsent[]> {
    const rows = await this.prisma.consent.findMany({
      where: subjectOf(actor),
      include: { legalDocument: { select: { version: true } } },
      orderBy: { acceptedAt: 'desc' },
    });
    return rows.map((row) => shape(row, row.legalDocument.version));
  }

  /**
   * Whether this person has accepted the version of `documentType` that is
   * current RIGHT NOW. Publishing a new version therefore withdraws the gate
   * until it is accepted again, which is the point of versioning it.
   */
  async hasCurrentConsent(
    actor: AuthenticatedActor,
    documentType: LegalDocumentType,
  ): Promise<boolean> {
    const count = await this.prisma.consent.count({
      where: {
        ...subjectOf(actor),
        documentType,
        legalDocument: { isCurrent: true },
      },
    });
    return count > 0;
  }

  /**
   * *** THE PRE-CONSULT GATE ***
   *
   * SRS 6.2 and FR-2.3: no consultation may start without a recorded
   * teleconsultation consent. M-11 calls this before a booking is created and
   * M-14 before a join token is issued; it is a method rather than a column so
   * there is exactly one implementation of the rule.
   */
  async assertTeleconsultationConsent(actor: AuthenticatedActor): Promise<void> {
    const consented = await this.hasCurrentConsent(actor, 'teleconsultation_consent');
    if (!consented) {
      throw new AppException(
        LegalError.CONSENT_REQUIRED,
        'Please accept the teleconsultation consent before starting a consultation.',
        HttpStatus.FORBIDDEN,
      );
    }
  }
}

/**
 * Which column carries the subject. `consents` has a CHECK that exactly one of
 * `patient_id` and `doctor_id` is set, so this is the only shape allowed.
 */
function subjectOf(actor: AuthenticatedActor): { patientId: string } | { doctorId: string } {
  if (actor.type === 'patient') return { patientId: actor.id };
  if (actor.type === 'doctor') return { doctorId: actor.id };
  throw new AppException(
    LegalError.CONSENT_REQUIRED,
    'Only a patient or a doctor can accept a legal document.',
    HttpStatus.FORBIDDEN,
  );
}

function shape(consent: Consent, version: string): AcceptedConsent {
  return {
    documentType: consent.documentType,
    legalDocumentId: consent.legalDocumentId,
    version,
    acceptedAt: consent.acceptedAt,
  };
}
