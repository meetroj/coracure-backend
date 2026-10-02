import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { DoctorRegistrationService } from './doctor-registration.service';
import { DoctorRegistryService } from './doctor-registry.service';
import { DoctorVerificationService } from './doctor-verification.service';
import {
  ConfirmCredentialUploadDto,
  RequestCredentialUploadDto,
  SaveRegistrationDto,
  UpdateOwnDoctorProfileDto,
} from './dto/doctor.dto';

/**
 * The provider app's own surface, plus the one patient-facing read that
 * survived SRS 1.2: the profile of the provider assigned to that patient.
 *
 * None of these routes carries `@VerifiedDoctorsOnly()`: this is precisely
 * what an unverified doctor is allowed to do - see their status, read what an
 * admin rejected, and upload replacements. Everything that is part of
 * consulting lives in later modules and carries the guard.
 */
@ApiTags('doctors')
@ApiBearerAuth()
@Controller({ version: '1' })
export class DoctorsController {
  constructor(
    private readonly registry: DoctorRegistryService,
    private readonly verification: DoctorVerificationService,
    private readonly registration: DoctorRegistrationService,
  ) {}

  @Roles('doctor')
  @Get('me/doctor/registration')
  @ApiOperation({
    summary: 'The doctor\'s own onboarding details',
    description: 'The government ID number is never returned, only its last four characters.',
  })
  getOwnRegistration(@CurrentActor() actor: AuthenticatedActor) {
    return this.registration.get(actor.id);
  }

  @Roles('doctor')
  @Put('me/doctor/registration')
  @ApiOperation({
    summary: 'State or correct the onboarding details',
    description:
      'Upload documents through /me/doctor/credentials first and reference their ids here. The experience list is replaced as a whole. Refused with REGISTRATION_LOCKED once verified.',
  })
  saveOwnRegistration(@CurrentActor() actor: AuthenticatedActor, @Body() dto: SaveRegistrationDto) {
    return this.registration.save(actor.id, dto);
  }

  // -- The doctor's own account ---------------------------------------------

  @Roles('doctor')
  @Get('me/doctor/profile')
  @ApiOperation({
    summary: 'My profile and how far through verification I am',
    description:
      '`isBookable` is true only when an admin has both verified AND listed the account. `canPrescribe` comes from the specialty, never from the doctor row.',
  })
  getOwnProfile(@CurrentActor() actor: AuthenticatedActor) {
    return this.registry.getSelfProfile(actor.id);
  }

  @Roles('doctor')
  @Patch('me/doctor/profile')
  @ApiOperation({
    summary: 'Edit my profile',
    description:
      'Bio, languages, consultation length and buffer only. Qualification, registration number, specialty and fee are what an admin verified, so they are changed by an admin.',
  })
  updateOwnProfile(
    @Body() dto: UpdateOwnDoctorProfileDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.registry.updateSelf(actor.id, dto);
  }

  // -- Credentials ----------------------------------------------------------

  @Roles('doctor')
  @Get('me/doctor/credentials')
  @ApiOperation({
    summary: 'My credentials, and what is still outstanding',
    description:
      '`outstanding` is what my specialty requires and I have not had approved yet. `rejected` is the subset an admin turned down, each with the reason to act on.',
  })
  getOwnCredentials(@CurrentActor() actor: AuthenticatedActor) {
    return this.verification.progressOf(actor.id);
  }

  @Roles('doctor')
  @Post('me/doctor/credentials/upload-url')
  @ApiOperation({
    summary: 'Get a signed URL to upload a credential to',
    description:
      'PUT the file straight to `upload.url` with the same content type, then call the confirm endpoint with the `storageKey` returned here. The file never passes through this API.',
  })
  requestUpload(
    @Body() dto: RequestCredentialUploadDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.verification.requestUpload(actor.id, dto);
  }

  @Roles('doctor')
  @Post('me/doctor/credentials')
  @ApiOperation({
    summary: 'Record a credential once it is uploaded',
    description:
      'The first credential moves the account from `pending` to `under_review`, which is the queue an admin works from. A rejected document is replaced by uploading a new one; the old row stays as history.',
  })
  confirmUpload(
    @Body() dto: ConfirmCredentialUploadDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.verification.confirmUpload(actor.id, dto);
  }

  @Roles('doctor', 'admin')
  @Get('doctor-credentials/:documentId/download-url')
  @ApiOperation({
    summary: 'A short-lived link to one credential file',
    description:
      'Only the doctor it belongs to and an admin can ask, the link expires in minutes, and every read is an audit entry. `storageKey` is never returned to anyone.',
  })
  download(@Param('documentId') documentId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.verification.downloadUrl(documentId, actor);
  }

  // -- The provider assigned to me ------------------------------------------
  //
  // *** THERE IS NO DIRECTORY ROUTE HERE. ***  SRS 1.2 removed patient-led
  // provider selection: `GET /doctors`, its filters and its sort by fee are
  // gone. A patient picks a SERVICE from M-06's `GET /services`, and the system
  // assigns the person.

  @Roles('patient')
  @Get('doctors/:doctorId')
  @ApiOperation({
    summary: 'The profile of the provider assigned to me (FR-4.3)',
    description:
      'Refused unless this provider is actually treating this patient. The Telemedicine Practice Guidelines require the patient to know who they are consulting - they do not permit browsing everyone else. Until M-11 supplies the assignment lookup this refuses every request.',
  })
  getAssignedProvider(
    @Param('doctorId') doctorId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.registry.getAssignedListing(doctorId, actor.id);
  }
}
