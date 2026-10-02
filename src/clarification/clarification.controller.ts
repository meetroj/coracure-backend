import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { ClarificationService } from './clarification.service';
import {
  AssignExpertDto,
  AuthorReplyDto,
  CaseInputDto,
  CaseListQueryDto,
  ExpertReplyDto,
} from './dto/clarification.dto';

/**
 * The treating doctor's side: raise a case, post it, answer the expert, close it.
 *
 * `@VerifiedDoctorsOnly()` because raising a case is part of consulting — a
 * provider whose approval was withdrawn stops being able to share a patient's
 * case at the same moment they stop being able to see patients.
 */
@ApiTags('case-clarification')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor/clarification-cases', version: '1' })
export class TreatingDoctorClarificationController {
  constructor(private readonly cases: ClarificationService) {}

  @Get()
  @ApiOperation({ summary: 'The cases I have raised' })
  mine(@Query() query: CaseListQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.listMine(actor, query.openOnly ?? false);
  }

  @Post()
  @ApiOperation({
    summary: 'Start a de-identified case (FR-12.1)',
    description:
      'A draft, visible to nobody but you. The free text is scanned for phone numbers, emails and other direct identifiers and REFUSED rather than redacted — you should know exactly what a reviewer will be shown.',
  })
  create(@Body() dto: CaseInputDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.createDraft(dto, actor);
  }

  @Get(':caseId')
  @ApiOperation({ summary: 'One of my cases, with the discussion' })
  get(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.getForAuthor(caseId, actor);
  }

  @Patch(':caseId')
  @ApiOperation({
    summary: 'Edit a draft',
    description: 'Only while it is a draft. Nobody may rewrite what an expert has already read.',
  })
  update(
    @Param('caseId') caseId: string,
    @Body() dto: CaseInputDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.cases.updateDraft(caseId, dto, actor);
  }

  @Post(':caseId/post')
  @ApiOperation({
    summary: 'Submit it for an expert (FR-12.1)',
    description:
      'Scanned for identifiers again here — this is the last moment before the text becomes visible outside the treating relationship. An admin then chooses who reviews it.',
  })
  post(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.post(caseId, actor);
  }

  @Post(':caseId/reply')
  @ApiOperation({
    summary: 'Answer the expert, or add context',
    description:
      'Answering a clarification request puts the case back with the expert. A reply on an answered case adds context without re-opening the question.',
  })
  reply(
    @Param('caseId') caseId: string,
    @Body() dto: AuthorReplyDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.cases.replyAsAuthor(caseId, dto.body, actor);
  }

  @Post(':caseId/reviewed')
  @ApiOperation({
    summary: 'Mark that I have read and weighed the advice (FR-12.6)',
    description:
      'FR-12.7: the treating doctor remains responsible for the treatment plan. Marking a case reviewed records that the advice was considered — it never means it was followed, and nothing reaches the patient from here.',
  })
  reviewed(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.markReviewed(caseId, actor);
  }

  @Post(':caseId/close')
  @ApiOperation({ summary: 'Close a case' })
  close(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.close(caseId, actor);
  }
}

/**
 * *** THE EXPERT'S SIDE, AND M-17'S COMPLETION CRITERION. ***
 *
 * "An expert account sees only its assigned cases."
 *
 * Every route here filters on the ASSIGNMENT, not on seniority. There is no
 * endpoint that lists cases an expert could be asked about, and no way to reach
 * one by id without holding the assignment on it — an unassigned expert gets the
 * same 404 a stranger would.
 *
 * Note also what these responses omit: no `sourceConsultationId`, no patient,
 * and no treating doctor. The reviewer answers a clinical question; they are not
 * auditing a colleague.
 */
@ApiTags('case-clarification')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor/expert-reviews', version: '1' })
export class ExpertClarificationController {
  constructor(private readonly cases: ClarificationService) {}

  @Get()
  @ApiOperation({
    summary: 'Cases shared with me (FR-12.4)',
    description: 'Only what has been assigned to me. Urgent first, then longest waiting.',
  })
  assigned(@Query() query: CaseListQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.listAssignedToMe(actor, query.openOnly ?? true);
  }

  @Get(':caseId')
  @ApiOperation({
    summary: 'One case shared with me',
    description:
      'The de-identified snapshot and the discussion. There is no link back to the consultation or the patient, by construction.',
  })
  get(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.getForExpert(caseId, actor);
  }

  @Post(':caseId/reply')
  @ApiOperation({
    summary: 'Comment, raise a consideration, ask for more, or advise follow-up (FR-12.5)',
    description:
      'The kind drives the case status, which is what makes the treating doctor’s queue meaningful: `clarification_request` puts it back on their desk, everything else puts an answer on it.',
  })
  reply(
    @Param('caseId') caseId: string,
    @Body() dto: ExpertReplyDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.cases.replyAsExpert(caseId, dto.messageType, dto.body, actor);
  }
}

/**
 * The admin's side: choosing who reviews a case.
 *
 * Assignment is an ADMIN's decision, not the author's. A treating doctor cannot
 * route their own case to a friendly colleague, and which admin chose is the
 * audit entry rather than a column — it is a decision, not an attribute.
 */
@ApiTags('admin/case-clarification')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/clarification-cases', version: '1' })
export class AdminClarificationController {
  constructor(private readonly cases: ClarificationService) {}

  @Get()
  @ApiOperation({
    summary: 'Cases waiting for an expert',
    description: 'Posted and unassigned. Urgent first, then longest waiting.',
  })
  queue(@CurrentActor() actor: AuthenticatedActor) {
    return this.cases.listAwaitingAssignment(actor);
  }

  @Get('experts')
  @ApiOperation({
    summary: 'Who may be asked (FR-12.4, first check)',
    description:
      'Verified doctors at `expert` seniority, with how much each is already holding so the queue can be spread. Being on this list grants no visibility of anything — only an assignment does.',
  })
  experts(
    @Query('excludeDoctorId') excludeDoctorId: string | undefined,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.cases.eligibleExperts(actor, excludeDoctorId);
  }

  @Post(':caseId/assign')
  @ApiOperation({
    summary: 'Share a case with one expert (FR-12.4, second check)',
    description:
      'The assignment is the only thing that grants visibility. Re-assigning moves the case to a different expert; the previous one loses sight of it at once.',
  })
  assign(
    @Param('caseId') caseId: string,
    @Body() dto: AssignExpertDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.cases.assign(caseId, dto.expertDoctorId, actor);
  }

  @Post(':caseId/close')
  @ApiOperation({ summary: 'Close a case from the panel' })
  close(@Param('caseId') caseId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.cases.close(caseId, actor);
  }
}
