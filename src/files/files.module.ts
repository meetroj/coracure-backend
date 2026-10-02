import { Global, Module } from '@nestjs/common';

import { objectStorageClass } from '../storage/object-storage';
import {
  ConsultationFilesController,
  DoctorFilesController,
  PatientFilesController,
} from './files.controller';
import { PATIENT_FILE_STORAGE } from './patient-file-storage';
import { PatientFilesService } from './patient-files.service';
import { ReportRequestsService } from './report-requests.service';

/**
 * M-10 Documents and File Storage. Owns `patient_files` and `report_requests`.
 *
 * Global because the modules after it write into the record it holds: M-11
 * attaches a patient's uploads to a booking, M-17 stores the prescription PDF
 * it renders, and M-12 takes de-identified copies for an expert opinion. They
 * all go through `PatientFilesService`, so the access rule has one home.
 *
 * It DECLARES `CONSULTATION_ACCESS` but no longer binds it. M-11 owns
 * `consultations` and supplies the real answer; the closed default is kept in
 * `consultation-access.ts` as the contract, and as what the tests exercise.
 *
 * MODULES puts its dependencies at M-01 and M-02 only, and that holds: the
 * shared object store is foundation code, and everything about a consultation
 * arrives through the port.
 */
@Global()
@Module({
  controllers: [PatientFilesController, DoctorFilesController, ConsultationFilesController],
  providers: [
    PatientFilesService,
    ReportRequestsService,
    // The same signing M-05 uses, under a different prefix and a different
    // access rule. `env.validation` refuses the stub in production.
    { provide: PATIENT_FILE_STORAGE, useClass: objectStorageClass() },
  ],
  // PATIENT_FILE_STORAGE is exported too: M-15 signs and writes the generated
  // prescription PDF directly through it (ClinicalRecordsService), not only
  // through PatientFilesService. `@Global()` only reaches a module's EXPORTED
  // providers - leaving this out is what took the API down on deploy.
  exports: [PatientFilesService, ReportRequestsService, PATIENT_FILE_STORAGE],
})
export class FilesModule {}
