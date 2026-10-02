import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import {
  ConfirmFileUploadDto,
  DoctorConfirmFileUploadDto,
  ListFilesQueryDto,
  RaiseReportRequestDto,
  RequestFileUploadDto,
} from './dto/files.dto';
import { PatientFilesService } from './patient-files.service';
import { ReportRequestsService } from './report-requests.service';

/**
 * The patient's own record (FR-4.6, FR-6.3).
 *
 * Uploading is two calls, and the bytes never touch this API: ask for a signed
 * URL, PUT the file straight to the object store, then confirm. That keeps a
 * large upload from occupying an API worker and means a stored file has no
 * public address at all.
 */
@ApiTags('files')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/files', version: '1' })
export class PatientFilesController {
  constructor(
    private readonly files: PatientFilesService,
    private readonly requests: ReportRequestsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My documents',
    description:
      'Everything I have uploaded and every PDF written for me, newest first. `medical_history` has no `consultationId`: it is held against me, not one booking, so it is still here at my next consultation.',
  })
  list(@Query() query: ListFilesQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.listFor(actor.id, actor, query);
  }

  @Post('upload-url')
  @ApiOperation({
    summary: 'Get a signed URL to upload a document to',
    description:
      'PUT the file straight to `upload.url` with the same content type, then call confirm with the `storageKey` returned here. The file never passes through this API.',
  })
  requestUpload(@Body() dto: RequestFileUploadDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.requestUpload(actor.id, dto);
  }

  @Post()
  @ApiOperation({
    summary: 'Confirm an upload, once the bytes are stored',
    description:
      'Send `reportRequestId` to answer a provider’s request — the file then arrives labelled, and the request is fulfilled by its arrival rather than by a second timestamp.',
  })
  confirmUpload(@Body() dto: ConfirmFileUploadDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.confirmUpload(actor.id, dto);
  }

  @Get(':fileId/download-url')
  @ApiOperation({
    summary: 'A short-lived link to open one document',
    description:
      'Expires in minutes and is signed fresh each time. The storage key is never returned, so a document has no address that can be shared onward (SRS 6.1). Every read is recorded.',
  })
  download(@Param('fileId') fileId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.downloadUrl(fileId, actor);
  }

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove one of my uploads',
    description:
      'Refused once a completed consultation has relied on it, and for anything my provider uploaded — by then it is part of a clinical record rather than my file.',
  })
  remove(@Param('fileId') fileId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.deleteOwnFile(fileId, actor.id);
  }

  @Get('requests/open')
  @ApiOperation({
    summary: 'What my provider has asked me for (FR-4.9)',
    description: 'Open requests across all my consultations, so nothing is missed in one booking.',
  })
  openRequests(@CurrentActor() actor: AuthenticatedActor) {
    return this.requests.openForPatient(actor.id);
  }
}

/**
 * The treating doctor's view of a patient's documents.
 *
 * `@VerifiedDoctorsOnly()` is the outer door; the inner one is
 * `ConsultationAccess.isTreating`, which is what actually decides. Verification
 * says somebody may practise on this platform - it says nothing about whether
 * they may read THIS patient, and only the second question protects the record.
 */
@ApiTags('files')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor', version: '1' })
export class DoctorFilesController {
  constructor(
    private readonly files: PatientFilesService,
    private readonly requests: ReportRequestsService,
  ) {}

  @Get('patients/:patientId/files')
  @ApiOperation({
    summary: 'A patient’s document history (FR-4.9)',
    description:
      'Everything for a patient I have consulted, INCLUDING what they uploaded before their first session with me — which is why medical history is held against the patient rather than a booking. A patient I have never consulted returns 404.',
  })
  listForPatient(
    @Param('patientId') patientId: string,
    @Query() query: ListFilesQueryDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.files.listFor(patientId, actor, query);
  }

  @Get('files/:fileId/download-url')
  @ApiOperation({ summary: 'Open one of my patient’s documents' })
  download(@Param('fileId') fileId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.files.downloadUrl(fileId, actor);
  }

  @Post('patients/:patientId/files/upload-url')
  @ApiOperation({
    summary: 'Get a signed URL to upload a document for a patient I treat',
    description:
      'PUT the file straight to `upload.url` with the same content type, then call confirm with the `storageKey` returned here. Refused for a patient I have never consulted.',
  })
  requestUpload(
    @Param('patientId') patientId: string,
    @Body() dto: RequestFileUploadDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.files.requestDoctorUpload(actor.id, patientId, dto);
  }

  @Post('patients/:patientId/files')
  @ApiOperation({
    summary: 'Confirm an upload for a patient, once the bytes are stored',
    description:
      'Always anchored to one of my consultations with this patient — never held against their general record, which stays theirs to add to.',
  })
  confirmUpload(
    @Param('patientId') patientId: string,
    @Body() dto: DoctorConfirmFileUploadDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.files.confirmDoctorUpload(actor.id, patientId, dto);
  }

  @Post('report-requests')
  @ApiOperation({
    summary: 'Ask a patient for a document (FR-4.9)',
    description:
      'Naming what is needed and why. The reason is shown to the patient, so what comes back is the right file rather than a guess.',
  })
  raise(@Body() dto: RaiseReportRequestDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.requests.raise(dto, actor);
  }

  @Post('report-requests/:requestId/cancel')
  @ApiOperation({
    summary: 'Withdraw a request I no longer need',
    description:
      'Only while it is open. One the patient has already answered is a record of what was asked and what arrived.',
  })
  cancel(@Param('requestId') requestId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.requests.cancel(requestId, actor);
  }
}

/**
 * The requests on one consultation, read by either party to it. Shared because
 * the patient and the doctor are looking at the same list from two sides.
 */
@ApiTags('files')
@ApiBearerAuth()
@Roles('patient', 'doctor')
@Controller({ path: 'consultations', version: '1' })
export class ConsultationFilesController {
  constructor(private readonly requests: ReportRequestsService) {}

  @Get(':consultationId/report-requests')
  @ApiOperation({
    summary: 'What was asked for on this consultation, and what came back',
    description: '`fulfilledBy` lists the files uploaded against each request.',
  })
  list(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.requests.listForConsultation(consultationId, actor);
  }
}
