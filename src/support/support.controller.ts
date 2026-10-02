import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import {
  AdminComplaintReplyDto,
  AssignComplaintDto,
  CloseComplaintDto,
  ComplaintQueryDto,
  ComplaintReplyDto,
  FeedbackQueryDto,
  RaiseComplaintDto,
  SubmitFeedbackDto,
} from './dto/support.dto';
import { SupportService } from './support.service';

/** FR-17.1. Feedback lives on the consultation, so the route does too. */
@ApiTags('support')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations/:consultationId', version: '1' })
export class PatientFeedbackController {
  constructor(private readonly support: SupportService) {}

  @Put('feedback')
  @ApiOperation({
    summary: 'Rate the consultation (FR-17.1)',
    description:
      'Only once the consultation has taken place — a cancellation is not a data point, and FR-18.6 reads these as evidence about a named clinician. A PUT, because a patient revising their own rating is an edit rather than a second opinion.',
  })
  submit(
    @Param('consultationId') consultationId: string,
    @Body() dto: SubmitFeedbackDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.support.submitFeedback(consultationId, dto, actor);
  }

  @Get('feedback')
  @ApiOperation({ summary: 'What I said about this consultation' })
  mine(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.myFeedback(consultationId, actor);
  }
}

/**
 * FR-17.2. Raising a complaint and tracking it.
 *
 * *** INTERNAL NOTES ARE ABSENT FROM EVERY RESPONSE HERE. *** Not blanked — a
 * redacted entry would still tell the patient that an admin wrote something
 * private about them at 14:32 on Tuesday, which is its own kind of unpleasant.
 */
@ApiTags('support')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/complaints', version: '1' })
export class PatientComplaintsController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @ApiOperation({ summary: 'My complaints, and where each has got to' })
  list(@CurrentActor() actor: AuthenticatedActor) {
    return this.support.myComplaints(actor);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise a complaint (FR-17.2)',
    description:
      'Returns a `CX-` reference code to quote to support — distinct from a consultation’s `CC-`, so whoever takes the call knows which kind of thing they have been given.',
  })
  raise(@Body() dto: RaiseComplaintDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.raiseComplaint(dto, actor);
  }

  @Get(':complaintId')
  @ApiOperation({ summary: 'One of my complaints, with the conversation' })
  get(@Param('complaintId') complaintId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.myComplaint(complaintId, actor);
  }

  @Post(':complaintId/reply')
  @ApiOperation({
    summary: 'Add to my complaint',
    description:
      'While it is open. A reply to a decision on a closed ticket would be an escalation nobody is watching — raise a new complaint instead, and it queues.',
  })
  reply(
    @Param('complaintId') complaintId: string,
    @Body() dto: ComplaintReplyDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.support.replyAsPatient(complaintId, dto.body, actor);
  }
}

/** FR-18.8. Feedback review, the complaint workflow and resolution tracking. */
@ApiTags('admin/support')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('feedback')
  @ApiOperation({
    summary: 'Patient feedback review (FR-18.8)',
    description:
      'Only consultations that were actually rated — an unrated one is not a data point. Filter by `doctorId` for one provider, or `maxRating` to read what went badly.',
  })
  feedback(@Query() query: FeedbackQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.listFeedback(actor, query);
  }

  @Get('complaints')
  @ApiOperation({
    summary: 'The complaint queue (FR-18.8)',
    description: 'Oldest first. `unassignedOnly` is what nobody has picked up.',
  })
  list(@Query() query: ComplaintQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.listComplaints(actor, query);
  }

  @Get('complaints/:complaintId')
  @ApiOperation({
    summary: 'One complaint, with the FULL thread',
    description: 'This is the one place internal notes are readable.',
  })
  get(@Param('complaintId') complaintId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.support.getComplaint(complaintId, actor);
  }

  @Post('complaints/:complaintId/assign')
  @ApiOperation({
    summary: 'Pick a complaint up',
    description:
      'Also moves it to `in_progress`: a ticket somebody has taken responsibility for is being worked, and two clicks to say one thing produces queues full of assigned-but-open tickets nobody trusts.',
  })
  assign(
    @Param('complaintId') complaintId: string,
    @Body() dto: AssignComplaintDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.support.assign(complaintId, dto.assignToAdminId, actor);
  }

  @Post('complaints/:complaintId/reply')
  @ApiOperation({
    summary: 'Write on the ticket — to the patient, or to the file',
    description:
      'Set `isInternal` for a note the patient never sees. The FACT that an internal note was written is audited; its contents are not.',
  })
  reply(
    @Param('complaintId') complaintId: string,
    @Body() dto: AdminComplaintReplyDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.support.replyAsAdmin(complaintId, dto.body, dto.isInternal ?? false, actor);
  }

  @Post('complaints/:complaintId/close')
  @ApiOperation({
    summary: 'Resolve or reject it (FR-18.8)',
    description:
      'Both endings need a note, and both need an owner — somebody has to stand behind the decision. `resolved` sets `resolvedAt`; `rejected` deliberately does not, so "how many did we resolve" stays answerable.',
  })
  close(
    @Param('complaintId') complaintId: string,
    @Body() dto: CloseComplaintDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.support.close(complaintId, dto.outcome, dto.resolutionNote, actor);
  }
}
