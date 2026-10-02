import { HttpStatus, Injectable } from '@nestjs/common';
import { DoctorDocumentType, Prisma, ProviderType, Specialty } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { CatalogueError } from './catalogue.errors';

/**
 * What a patient sees when choosing a service (FR-4.1). Never a person: the
 * price and the soonest time belong to the SERVICE, because the patient does
 * not choose who provides it.
 */
export interface ServiceListing {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** What the patient pays. Quoted before a provider is assigned. */
  consultationFeeInr: number;
  /** Shapes the patient-facing copy: a doctor is addressed differently. */
  providerType: ProviderType;
  /** Whether a consultation of this service can end in a medicine prescription. */
  canPrescribe: boolean;
}

/** The admin view. Adds the configuration a patient never sees. */
export interface SpecialtyRecord extends ServiceListing {
  intakeForm: Prisma.JsonValue | null;
  firstConsultForm: Prisma.JsonValue | null;
  requiredDocuments: DoctorDocumentType[];
  isActive: boolean;
  createdAt: Date;
}

export interface SpecialtyInput {
  code: string;
  name: string;
  description?: string;
  providerType: ProviderType;
  canPrescribe?: boolean;
  consultationFeeInr: number;
  /** A form is an object; `InputJsonValue` also admits arrays and scalars. */
  intakeForm?: Record<string, unknown>;
  firstConsultForm?: Record<string, unknown>;
  requiredDocuments?: DoctorDocumentType[];
}

export type SpecialtyPatch = Partial<SpecialtyInput> & { isActive?: boolean };

/**
 * M-06's centre. A specialty row is what makes a new service go live: it
 * carries the price the patient is quoted, which registration form a provider
 * of it is created on, whether it may prescribe, the intake questions, and the
 * credentials M-05 demands before verification.
 *
 * Adding one is an admin action. There is no code change and no app release,
 * which is the whole of FR-19.1.
 */
@Injectable()
export class SpecialtiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** FR-4.1's service picker. Active specialties only, cheapest question first. */
  async listServices(): Promise<ServiceListing[]> {
    const rows = await this.prisma.specialty.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(toListing);
  }

  async listAll(includeInactive = true): Promise<SpecialtyRecord[]> {
    const rows = await this.prisma.specialty.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(toRecord);
  }

  async get(specialtyId: string): Promise<SpecialtyRecord> {
    return toRecord(await this.require(specialtyId));
  }

  async create(input: SpecialtyInput, actor: AuthenticatedActor): Promise<SpecialtyRecord> {
    assertPrescribingIsAllowed(input.providerType, input.canPrescribe);

    let created: Specialty;
    try {
      created = await this.prisma.specialty.create({
        data: {
          code: input.code,
          name: input.name,
          providerType: input.providerType,
          consultationFeeInr: new Prisma.Decimal(input.consultationFeeInr),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.canPrescribe !== undefined ? { canPrescribe: input.canPrescribe } : {}),
          ...(input.intakeForm !== undefined
            ? { intakeForm: input.intakeForm as Prisma.InputJsonValue }
            : {}),
          ...(input.firstConsultForm !== undefined
            ? { firstConsultForm: input.firstConsultForm as Prisma.InputJsonValue }
            : {}),
          ...(input.requiredDocuments !== undefined
            ? { requiredDocuments: input.requiredDocuments }
            : {}),
        },
      });
    } catch (error) {
      throw duplicateCode(error, 'specialty');
    }

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'specialty',
      entityId: created.id,
      metadata: {
        code: input.code,
        providerType: input.providerType,
        canPrescribe: created.canPrescribe,
        feeInr: input.consultationFeeInr,
      },
    });
    return toRecord(created);
  }

  /**
   * Edits a specialty. Changing the fee changes what the NEXT patient is
   * quoted; invoices already issued are frozen on the payment row, so a price
   * rise never rewrites a bill somebody has already paid.
   */
  async update(
    specialtyId: string,
    patch: SpecialtyPatch,
    actor: AuthenticatedActor,
  ): Promise<SpecialtyRecord> {
    const before = await this.require(specialtyId);
    assertPrescribingIsAllowed(
      patch.providerType ?? before.providerType,
      patch.canPrescribe ?? before.canPrescribe,
    );

    // Taking a specialty out of service is not a delete: providers are
    // registered under it and consultations point at it. `is_active = false`
    // stops it being offered and leaves the history readable.
    if (patch.isActive === false) await this.assertNoActiveProviders(specialtyId);

    const data: Prisma.SpecialtyUpdateInput = {
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.providerType !== undefined ? { providerType: patch.providerType } : {}),
      ...(patch.canPrescribe !== undefined ? { canPrescribe: patch.canPrescribe } : {}),
      ...(patch.consultationFeeInr !== undefined
        ? { consultationFeeInr: new Prisma.Decimal(patch.consultationFeeInr) }
        : {}),
      ...(patch.intakeForm !== undefined
        ? { intakeForm: patch.intakeForm as Prisma.InputJsonValue }
        : {}),
      ...(patch.firstConsultForm !== undefined
        ? { firstConsultForm: patch.firstConsultForm as Prisma.InputJsonValue }
        : {}),
      ...(patch.requiredDocuments !== undefined
        ? { requiredDocuments: patch.requiredDocuments }
        : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    };

    let updated: Specialty;
    try {
      updated = await this.prisma.specialty.update({ where: { id: specialtyId }, data });
    } catch (error) {
      throw duplicateCode(error, 'specialty');
    }

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'specialty',
      entityId: specialtyId,
      // The fee and the prescribing flag are recorded with their values. One is
      // money, the other decides whether medicines can be issued.
      metadata: {
        fields: Object.keys(data),
        ...(patch.consultationFeeInr !== undefined
          ? { feeInr: { from: Number(before.consultationFeeInr), to: patch.consultationFeeInr } }
          : {}),
        ...(patch.canPrescribe !== undefined
          ? { canPrescribe: { from: before.canPrescribe, to: patch.canPrescribe } }
          : {}),
      },
    });
    return toRecord(updated);
  }

  private async assertNoActiveProviders(specialtyId: string): Promise<void> {
    const providers = await this.prisma.doctor.count({
      where: { specialtyId, verificationStatus: 'verified', isListed: true },
    });
    if (providers > 0) {
      throw new AppException(
        CatalogueError.STILL_IN_USE,
        `${providers} listed provider(s) are registered under this specialty. Delist them first.`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async require(specialtyId: string): Promise<Specialty> {
    const found = await this.prisma.specialty.findUnique({ where: { id: specialtyId } });
    if (!found) {
      throw new AppException(
        CatalogueError.SPECIALTY_NOT_FOUND,
        'That specialty does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }
}

/**
 * *** THE PRESCRIBING RULE *** Only a doctor-form specialty may prescribe
 * medicines (SRS 4.3, 19.7). A CHECK enforces the same thing on the table; this
 * is here so the admin gets a sentence rather than a constraint violation.
 */
export function assertPrescribingIsAllowed(
  providerType: ProviderType,
  canPrescribe: boolean | undefined,
): void {
  if (canPrescribe && providerType !== ProviderType.doctor) {
    throw new AppException(
      CatalogueError.ONLY_DOCTORS_PRESCRIBE,
      'Only a doctor specialty can prescribe medicines. A non-doctor provider issues advice and a therapy plan.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** `required_documents` is jsonb; a CHECK keeps it an array, this keeps it typed. */
export function documentTypesOf(value: Prisma.JsonValue): DoctorDocumentType[] {
  const allowed = new Set<string>(Object.values(DoctorDocumentType));
  return Array.isArray(value)
    ? value.filter(
        (item): item is DoctorDocumentType => typeof item === 'string' && allowed.has(item),
      )
    : [];
}

function toListing(specialty: Specialty): ServiceListing {
  return {
    id: specialty.id,
    code: specialty.code,
    name: specialty.name,
    description: specialty.description,
    consultationFeeInr: Number(specialty.consultationFeeInr),
    providerType: specialty.providerType,
    canPrescribe: specialty.canPrescribe,
  };
}

function toRecord(specialty: Specialty): SpecialtyRecord {
  return {
    ...toListing(specialty),
    intakeForm: specialty.intakeForm,
    firstConsultForm: specialty.firstConsultForm,
    requiredDocuments: documentTypesOf(specialty.requiredDocuments),
    isActive: specialty.isActive,
    createdAt: specialty.createdAt,
  };
}

/** The unique index on `code`, as an answer an admin can act on. */
export function duplicateCode(error: unknown, what: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new AppException(
      CatalogueError.CODE_ALREADY_EXISTS,
      `A ${what} with that code already exists.`,
      HttpStatus.CONFLICT,
    );
  }
  return error;
}
