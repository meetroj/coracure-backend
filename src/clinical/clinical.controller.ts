import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { ClinicalRecordsService } from './clinical-records.service';
import { SaveClinicalRecordDto } from './dto/clinical.dto';

/**
 * Writing up a consultation (FR-9.3 to FR-9.5, FR-11.1 to FR-11.5).
 *
 * Doctor-only, and `@VerifiedDoctorsOnly()` because authoring a clinical record
 * is the most consequential thing a professional does on this platform: it
 * reads the row rather than the token, so a provider whose approval is
 * withdrawn cannot write a prescription on a session issued before that.
 */
@ApiTags('clinical')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor', version: '1' })
export class DoctorClinicalController {
  constructor(private readonly records: ClinicalRecordsService) {}

  @Get('pending-documentation')
  @ApiOperation({
    summary: 'Consultations I have held and not written up (FR-9.3)',
    description:
      'Each entry carries what is still outstanding on it, so the worklist and the finalise call agree by construction: this shows what is missing, and finalising refuses while anything is.',
  })
  pending(@CurrentActor() actor: AuthenticatedActor) {
    return this.records.pendingFor(actor.id);
  }

  @Put('consultations/:consultationId/clinical-record')
  @ApiOperation({
    summary: 'Save the clinical record (FR-11.1)',
    description:
      'Idempotent, and safe to call as often as the form autosaves. Medicines are refused unless your specialty may prescribe (FR-4.3). Nothing here completes the case — that is the finalise call.',
  })
  save(
    @Param('consultationId') consultationId: string,
    @Body() dto: SaveClinicalRecordDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.records.save(consultationId, dto, actor);
  }

  @Get('consultations/:consultationId/clinical-record')
  @ApiOperation({
    summary: 'The record so far, with what it still needs',
    description: '`outstanding` is empty exactly when the case can be completed.',
  })
  get(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.records.forDoctor(consultationId, actor);
  }

  @Post('consultations/:consultationId/clinical-record/finalise')
  @ApiOperation({
    summary: 'Complete the case (FR-11.5)',
    description:
      'Freezes the record, completes the consultation and opens the instant-consult gate, together. Refused with a checklist while anything is outstanding — the rule is enforced by the system, not by convention. There is no way to edit a record afterwards.',
  })
  finalise(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.records.finalise(consultationId, actor);
  }
}

/** What the patient was given, once it has been issued. */
@ApiTags('clinical')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations/:consultationId', version: '1' })
export class PatientClinicalController {
  constructor(private readonly records: ClinicalRecordsService) {}

  @Get('care-record')
  @ApiOperation({
    summary: 'My prescription and advice for this consultation',
    description:
      'Available once the doctor has finalised it — a draft is not shown, because half a prescription is worse than none. Narrower than the professional record: the diagnosis, what to take, what to do and when to worry, without the clinical history, case summary or risk category.',
  })
  careRecord(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.records.forPatient(consultationId, actor);
  }
}

/** Clinical governance reads records; it never writes them. */
@ApiTags('admin/clinical')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/consultations/:consultationId', version: '1' })
export class AdminClinicalController {
  constructor(private readonly records: ClinicalRecordsService) {}

  @Get('clinical-record')
  @ApiOperation({
    summary: 'The clinical record, for governance review (FR-18.5)',
    description:
      'Read only. An admin cannot author or alter a clinical record: the professional who saw the patient is the one accountable for what it says.',
  })
  get(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.records.forAdmin(consultationId, actor);
  }
}
