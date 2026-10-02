import { Injectable } from '@nestjs/common';
import { DoctorDocumentType, ProviderType } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import {
  BASELINE_DOCUMENTS_KEY,
  BASELINE_REQUIRED_DOCUMENTS,
  SpecialtyCatalogue,
} from '../doctors/specialty-catalogue';
import { documentTypesOf } from './specialties.service';

const REQUIRED_DOCUMENTS = z.array(z.enum(DoctorDocumentType));

/**
 * M-06's answer to M-05's `SPECIALTY_CATALOGUE` port. This is the module that
 * owns `specialties`, so it is the module that answers questions about one.
 *
 * Every read is a single indexed lookup by primary key and the values change
 * rarely, so there is no cache here: `AppConfigService` already caches the
 * baseline, and a specialty row is one round trip on a verification or a
 * booking, not per request.
 */
@Injectable()
export class DatabaseSpecialtyCatalogue implements SpecialtyCatalogue {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * *** THE BASELINE IS A FLOOR, NOT A DEFAULT. ***
   *
   * The answer is the union of the baseline every provider must submit and
   * whatever this specialty adds. A specialty row created with an empty
   * `required_documents` would otherwise make verification trivially
   * satisfiable, and an admin could sign off a provider who had uploaded
   * nothing - the one outcome SRS section 8 cannot tolerate. Taking the union
   * means the admin form can only ever ask for MORE.
   */
  async requiredDocuments(specialtyId: string | null): Promise<DoctorDocumentType[]> {
    const baseline =
      (await this.config.get(BASELINE_DOCUMENTS_KEY, REQUIRED_DOCUMENTS)) ??
      BASELINE_REQUIRED_DOCUMENTS;

    const specialty = specialtyId ? await this.read(specialtyId) : null;
    const specific = specialty ? documentTypesOf(specialty.requiredDocuments) : [];

    return [...new Set([...baseline, ...specific])];
  }

  /**
   * FR-4.3. A provider with no specialty set cannot prescribe: the permission
   * comes from the service, and there is no service yet.
   */
  async canPrescribe(specialtyId: string | null): Promise<boolean> {
    if (!specialtyId) return false;
    const specialty = await this.read(specialtyId);
    // An inactive specialty grants nothing. Taking a service out of use must
    // not leave its prescribing right standing.
    return Boolean(specialty?.isActive && specialty.canPrescribe);
  }

  /**
   * FR-19.7. The registration form decides whether a medical council number is
   * required, and the form is `provider_type` on the specialty.
   *
   * A `non_doctor` specialty - psychologist, therapist, counsellor - holds no
   * council registration, so demanding one would make that form impossible to
   * complete. This is exactly why the form lives on the specialty and not on
   * the provider: one column answers the credential list, prescribing AND this,
   * and the three can never drift apart.
   */
  async requiresRegistrationNumber(specialtyId: string | null): Promise<boolean> {
    if (!specialtyId) return false;
    const specialty = await this.read(specialtyId);
    return specialty?.providerType === ProviderType.doctor;
  }

  /** FR-7.8. What the patient is quoted, before any provider is assigned. */
  async patientFeeInr(specialtyId: string | null): Promise<number | null> {
    if (!specialtyId) return null;
    const specialty = await this.read(specialtyId);
    return specialty ? Number(specialty.consultationFeeInr) : null;
  }

  private read(specialtyId: string) {
    return this.prisma.specialty.findUnique({
      where: { id: specialtyId },
      select: {
        isActive: true,
        canPrescribe: true,
        providerType: true,
        consultationFeeInr: true,
        requiredDocuments: true,
      },
    });
  }
}
