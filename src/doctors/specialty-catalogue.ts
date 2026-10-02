import { Injectable } from '@nestjs/common';
import { DoctorDocumentType } from '@prisma/client';
import * as z from 'zod';

import { AppConfigService } from '../app-config/app-config.service';

/**
 * The three questions M-05 asks about a specialty:
 *
 *   1. which credentials a doctor of that specialty must submit, which is what
 *      decides when verification is allowed to complete;
 *   2. whether that specialty may prescribe medicines, which decides whether a
 *      provider writes a prescription or an advice and therapy plan;
 *   3. what a patient is charged for it, which since SRS 1.2 is a property of
 *      the SERVICE rather than of the provider - a patient who cannot choose
 *      their provider has to be quoted before one is assigned (FR-7.8).
 *
 * Both answers live on the `specialties` row that M-06 owns and that does not
 * exist yet, so this is a port. M-06 supplies the real implementation by
 * overriding this provider - see MODULES M-06, "specialty-wise list of the
 * credentials a doctor of that specialty must submit, used by M-05
 * verification".
 */
export const SPECIALTY_CATALOGUE = Symbol('SpecialtyCatalogue');

export interface SpecialtyCatalogue {
  /**
   * The credentials a doctor of this specialty must have approved before they
   * can be verified. A doctor with no specialty set yet gets the baseline.
   */
  requiredDocuments(specialtyId: string | null): Promise<DoctorDocumentType[]>;

  /** FR-4.3: prescribing eligibility is a property of the specialty, not the provider. */
  canPrescribe(specialtyId: string | null): Promise<boolean>;

  /**
   * FR-19.7: whether a provider of this specialty must hold a MEDICAL COUNCIL
   * REGISTRATION NUMBER before they can be verified.
   *
   * True for a `doctor`-form specialty, false for a non-doctor one - a
   * counsellor or psychologist holds no council registration, and demanding one
   * would make their form impossible to complete. This is the third thing the
   * registration form decides, alongside the credential list and prescribing,
   * and it is on the SPECIALTY for the same reason those two are.
   */
  requiresRegistrationNumber(specialtyId: string | null): Promise<boolean>;

  /**
   * FR-7.8: what the PATIENT pays for this service. Null where the specialty
   * is unknown or unset. `doctors.consultation_fee_inr` is a different number -
   * it is what that provider is paid.
   */
  patientFeeInr(specialtyId: string | null): Promise<number | null>;
}

export const REQUIRED_DOCUMENTS_SCHEMA = z.array(z.enum(DoctorDocumentType)).min(1);
const REQUIRED_DOCUMENTS = REQUIRED_DOCUMENTS_SCHEMA;

export const BASELINE_DOCUMENTS_KEY = 'doctors.baseline_required_documents';

/**
 * What every doctor submits whatever their specialty: the degree, the council
 * registration and proof of identity. Installed into `app_config` on first
 * boot, so the client can change the baseline without a release.
 */
export const BASELINE_REQUIRED_DOCUMENTS: DoctorDocumentType[] = [
  DoctorDocumentType.degree_certificate,
  DoctorDocumentType.registration_certificate,
  DoctorDocumentType.identity_proof,
];

/**
 * The answer before M-06 landed, kept as the fallback M-06's adapter falls back
 * ON: it holds the baseline every provider must submit whatever their specialty.
 *
 * `requiredDocuments` returns the configured baseline rather than an empty
 * list: an empty list would let an admin verify a doctor who has uploaded
 * nothing at all, which is the one outcome SRS section 8 cannot tolerate.
 *
 * `canPrescribe` returns FALSE for every specialty. Prescribing is the gate
 * that separates a psychiatrist from a psychologist, and a rule that is not
 * implemented yet must refuse rather than allow.
 */
@Injectable()
export class BaselineSpecialtyCatalogue implements SpecialtyCatalogue {
  constructor(private readonly config: AppConfigService) {}

  async requiredDocuments(): Promise<DoctorDocumentType[]> {
    return (
      (await this.config.get(BASELINE_DOCUMENTS_KEY, REQUIRED_DOCUMENTS)) ??
      BASELINE_REQUIRED_DOCUMENTS
    );
  }

  canPrescribe(): Promise<boolean> {
    // M-06 replaces this with `specialties.can_prescribe`.
    return Promise.resolve(false);
  }

  requiresRegistrationNumber(): Promise<boolean> {
    // M-06 replaces this with `specialties.provider_type = 'doctor'`. Without a
    // specialty there is no registration form, and therefore nothing declaring
    // that a council number applies - the baseline credential list is what
    // stops an unverifiable account being signed off in that state.
    return Promise.resolve(false);
  }

  patientFeeInr(): Promise<number | null> {
    // M-06 replaces this with `specialties.consultation_fee_inr`.
    return Promise.resolve(null);
  }
}
