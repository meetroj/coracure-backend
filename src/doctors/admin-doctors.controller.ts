import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { DoctorRegistryService } from './doctor-registry.service';
import { DoctorVerificationService } from './doctor-verification.service';
import {
  AdminDoctorQueryDto,
  CreateDoctorDto,
  SetDoctorRegionsDto,
  RejectDoctorDto,
  ReviewCredentialDto,
  SetListedDto,
  SetSeniorityDto,
  SuspendDoctorDto,
  UpdateDoctorDto,
} from './dto/doctor.dto';

/**
 * FR-18.1, the admin panel's doctor management.
 *
 * Two permission levels are used, deliberately:
 *
 *   `operations`          runs the roster - creating accounts, editing
 *                         profiles, setting fees and listing doctors.
 *   `clinical_governance` judges credentials - approving or rejecting each
 *                         document, verifying a doctor, and granting expert
 *                         level.
 *
 * They overlap where the panel is worked by one team, and `super_admin` passes
 * both by definition. Splitting them means the person who sets a fee is not, by
 * default, the person who decides a registration certificate is genuine.
 */
@ApiTags('admin/doctors')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/doctors', version: '1' })
export class AdminDoctorsController {
  constructor(
    private readonly registry: DoctorRegistryService,
    private readonly verification: DoctorVerificationService,
  ) {}

  // -- The roster -----------------------------------------------------------

  @Post()
  @ApiOperation({
    summary: 'Create a doctor account (FR-1.2)',
    description:
      'The only way a doctor account comes into being - there is no self sign-up path anywhere in the platform. The doctor can then sign in on this mobile number and upload credentials, and nothing else.',
  })
  create(@Body() dto: CreateDoctorDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations');
    return this.registry.create(dto, actor);
  }

  @Get()
  @ApiOperation({
    summary: 'The doctor roster, in every state',
    description: 'Filter by verification status, listing, specialty, language and fee.',
  })
  list(@Query() query: AdminDoctorQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'clinical_governance', 'care_coordinator');
    return this.registry.listForAdmin(query);
  }

  @Get('credential-queue')
  @ApiOperation({
    summary: 'Credentials waiting on a decision, oldest first',
    description: 'The approval queue. Each document is approved or rejected on its own.',
  })
  credentialQueue(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'clinical_governance', 'operations');
    return this.verification.pendingReviewQueue();
  }

  @Get(':doctorId')
  @ApiOperation({ summary: 'One doctor, in full' })
  get(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'clinical_governance', 'care_coordinator');
    return this.registry.getAccount(doctorId);
  }

  @Get(':doctorId/reliability')
  @ApiOperation({
    summary: 'Acceptance rate, no-show rate and case summary completion (FR-18.6)',
    description:
      'COUNTED from consultations and instant consultancies when asked, never stored as counters. Every rate is null until M-11 and M-13 supply the rows to count.',
  })
  reliability(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'clinical_governance');
    return this.registry.reliabilityOf(doctorId);
  }

  @Patch(':doctorId')
  @ApiOperation({
    summary: 'Edit the profile, the payout fee and the instant-consult permission',
    description:
      '`payoutFeeInr` is what this provider is PAID. What the patient is charged is the specialty fee, set in M-06 - a patient who cannot choose their provider is quoted before one is assigned. Both the fee and the permission are recorded in the audit log with their values.',
  })
  update(
    @Param('doctorId') doctorId: string,
    @Body() dto: UpdateDoctorDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations');
    return this.registry.updateAsAdmin(doctorId, dto, actor);
  }

  // -- Verification ---------------------------------------------------------

  @Get(':doctorId/credentials')
  @ApiOperation({
    summary: "This doctor's credentials and what is outstanding",
    description:
      '`readyForVerification` is derived from the documents and the specialty\'s requirement list. There is no stored "complete" flag to disagree with them.',
  })
  credentials(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'clinical_governance', 'operations');
    return this.verification.progressOf(doctorId);
  }

  @Post('credentials/:documentId/review')
  @ApiOperation({
    summary: 'Approve or reject ONE credential, with a reason',
    description:
      'A decision is final: changing it later would rewrite the record of what was approved and when. The doctor uploads a replacement instead.',
  })
  reviewCredential(
    @Param('documentId') documentId: string,
    @Body() dto: ReviewCredentialDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'clinical_governance', 'operations');
    return this.verification.reviewDocument(documentId, dto, actor);
  }

  @Post(':doctorId/verify')
  @ApiOperation({
    summary: 'Verify the doctor (step 4 of 5)',
    description:
      'Refused with `CREDENTIALS_INCOMPLETE` while any required credential is missing or unapproved; the response names what is outstanding. Verifying does NOT list the doctor.',
  })
  verify(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'clinical_governance');
    return this.verification.verifyDoctor(doctorId, actor);
  }

  @Post(':doctorId/reject')
  @ApiOperation({
    summary: 'Turn the application down',
    description: 'The row and the uploads are kept. The doctor cannot sign in while rejected.',
  })
  reject(
    @Param('doctorId') doctorId: string,
    @Body() dto: RejectDoctorDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'clinical_governance');
    return this.verification.rejectDoctor(doctorId, dto.reason, actor);
  }

  @Post(':doctorId/reopen')
  @ApiOperation({
    summary: 'Reopen a rejected application',
    description: 'Approvals already given are kept - those documents have not changed.',
  })
  reopen(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'clinical_governance');
    return this.verification.reopen(doctorId, actor);
  }

  // -- Listing, seniority and suspension ------------------------------------

  @Patch(':doctorId/listing')
  @ApiOperation({
    summary: 'List or delist the doctor (step 5 of 5)',
    description:
      'Separate from verification on purpose, and refused unless the doctor is verified - a database CHECK enforces the same rule underneath.',
  })
  setListed(
    @Param('doctorId') doctorId: string,
    @Body() dto: SetListedDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations');
    return this.registry.setListed(doctorId, dto.isListed, actor);
  }

  @Get(':doctorId/regions')
  @ApiOperation({
    summary: 'The regions this provider serves',
    description: 'The pool assignment matches a patient region against (SRS 18.9).',
  })
  getRegions(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'clinical_governance', 'care_coordinator');
    return this.registry.regionsOf(doctorId);
  }

  @Patch(':doctorId/regions')
  @ApiOperation({
    summary: 'Set the regions this provider serves (FR-18.9)',
    description:
      'The whole set at once, not one at a time: the screen is a list of checkboxes, and a half-applied edit could leave a provider in a region they were being taken out of. Recorded in the audit log with the regions themselves, because this decides which patients can reach them.',
  })
  setRegions(
    @Param('doctorId') doctorId: string,
    @Body() dto: SetDoctorRegionsDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations');
    return this.registry.setRegions(doctorId, dto.regionIds, actor);
  }

  @Patch(':doctorId/seniority')
  @ApiOperation({
    summary: 'Grant or revoke expert level (FR-1.6)',
    description:
      'Expert makes a doctor ELIGIBLE to be asked for a case opinion. It grants sight of nothing on its own - the case still has to be assigned to them.',
  })
  setSeniority(
    @Param('doctorId') doctorId: string,
    @Body() dto: SetSeniorityDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'clinical_governance');
    return this.registry.setSeniority(doctorId, dto.seniorityLevel, actor);
  }

  @Post(':doctorId/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend the doctor (FR-18.1 "remove")',
    description:
      'A state, never a delete - the row is referenced by consultations and prescriptions that must outlive the account. Delists them and signs them out of every device.',
  })
  suspend(
    @Param('doctorId') doctorId: string,
    @Body() dto: SuspendDoctorDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations');
    return this.registry.suspend(doctorId, dto.reason, actor);
  }

  @Post(':doctorId/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a suspension',
    description:
      'A doctor who was verified comes back verified, one who was not comes back `pending`. Neither comes back listed - that is the separate second action.',
  })
  reinstate(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations');
    return this.registry.reinstate(doctorId, actor);
  }
}
