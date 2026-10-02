import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { CarePlanService } from './care-plan.service';
import {
  AlertQueryDto,
  AssignFollowupDto,
  CloseAlertDto,
  PublishPathwayDto,
  SubmitCheckinDto,
} from './dto/followup.dto';
import { FollowupService } from './followup.service';
import { PathwaysService } from './pathways.service';
import { SafetyAlertsService } from './safety-alerts.service';

/** The patient's side: the Care Plan, the daily check-in, and their own history. */
@ApiTags('follow-up')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations/:consultationId', version: '1' })
export class PatientFollowupController {
  constructor(
    private readonly followup: FollowupService,
    private readonly carePlan: CarePlanService,
  ) {}

  @Get('care-plan')
  @ApiOperation({
    summary: 'The Care Plan, in one call (FR-14.1)',
    description:
      'Prescription and warning signs, today’s check-in, the follow-up plan and the recommended reading. It stores nothing of its own — every part is read through the module that owns it, so nothing here can be stale.',
  })
  plan(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.carePlan.forPatient(consultationId, actor);
  }

  @Get('checkin')
  @ApiOperation({
    summary: 'Today’s check-in questions',
    description:
      'The clinician-approved set for the PINNED pathway version, plus any your provider added for you — those are marked `addedByDoctor` and never affect the result (FR-13.8).',
  })
  today(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.todaysCheckin(consultationId, actor);
  }

  @Post('checkin')
  @ApiOperation({
    summary: 'Submit today’s check-in (FR-13.1 to FR-13.5)',
    description:
      'Once per day. `showEmergencyGuidance` true means show it IMMEDIATELY (SRS 6.3) — it does not wait for anyone to respond to the alert this raises.',
  })
  submit(
    @Param('consultationId') consultationId: string,
    @Body() dto: SubmitCheckinDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.submitCheckin(consultationId, dto.answers, actor);
  }

  @Get('checkins')
  @ApiOperation({ summary: 'Every check-in I have submitted for this consultation' })
  history(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.historyFor(consultationId, actor);
  }
}

/** The doctor's side: assign the plan, read the answers, work the alerts. */
@ApiTags('follow-up')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor', version: '1' })
export class DoctorFollowupController {
  constructor(
    private readonly followup: FollowupService,
    private readonly pathways: PathwaysService,
    private readonly alerts: SafetyAlertsService,
  ) {}

  @Get('followup-pathways')
  @ApiOperation({
    summary: 'The pathways I can assign (FR-13.1)',
    description: 'The current version of each. Assigning pins the version the patient answers.',
  })
  available() {
    return this.pathways.listCurrent();
  }

  @Post('consultations/:consultationId/followup')
  @ApiOperation({
    summary: 'Start a follow-up plan (FR-9.7)',
    description:
      'Only once the clinical record is finalised — a follow-up plan is part of the treatment. Pins the pathway VERSION, so an admin publishing a revision mid-window does not change the questions under the patient.',
  })
  assign(
    @Param('consultationId') consultationId: string,
    @Body() dto: AssignFollowupDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.assign(
      consultationId,
      {
        pathwayCode: dto.pathwayCode,
        startsOn: dto.startsOn ? new Date(dto.startsOn) : undefined,
        extraQuestions: (dto.extraQuestions ?? []) as never,
      },
      actor,
    );
  }

  @Post('consultations/:consultationId/followup/cancel')
  @ApiOperation({ summary: 'Stop the daily check-ins early' })
  cancel(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.cancel(consultationId, actor);
  }

  @Get('consultations/:consultationId/checkins')
  @ApiOperation({ summary: 'What this patient has answered so far' })
  history(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.followup.historyFor(consultationId, actor);
  }

  @Get('consultations/:consultationId/followup-plan')
  @ApiOperation({
    summary: "The patient's current follow-up plan and day count",
    description:
      '`todayIsDay` is "day X of Y" for the app to show. Same read the patient gets on their own Care Plan (`planFor` already accepts either party) — this just exposes it to the doctor too.',
  })
  plan(@Param('consultationId') consultationId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.followup.planFor(consultationId, actor);
  }

  @Get('safety-alerts/:alertId')
  @ApiOperation({ summary: 'One safety alert in full' })
  getAlert(@Param('alertId') alertId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.getOne(alertId, actor);
  }

  @Get('safety-alerts')
  @ApiOperation({
    summary: 'Safety alerts on my patients (FR-9.8)',
    description: 'Open first and oldest first: what has nobody dealt with, and for how long.',
  })
  list(@Query() query: AlertQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.list(actor, query);
  }

  @Post('safety-alerts/:alertId/acknowledge')
  @ApiOperation({
    summary: 'Take responsibility for an alert',
    description:
      'Records WHO. An alert seen and judged not to need action is a clinical decision, and the person who made it has to be named.',
  })
  acknowledge(@Param('alertId') alertId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.acknowledge(alertId, actor);
  }

  @Post('safety-alerts/:alertId/close')
  @ApiOperation({ summary: 'Close an alert, saying what was done' })
  close(
    @Param('alertId') alertId: string,
    @Body() dto: CloseAlertDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.alerts.close(alertId, dto.closingNote, actor);
  }
}

/**
 * The admin's side: authoring the clinical content (FR-13.7) and working the
 * governance queue (FR-18.5).
 */
@ApiTags('admin/follow-up')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminFollowupController {
  constructor(
    private readonly pathways: PathwaysService,
    private readonly alerts: SafetyAlertsService,
  ) {}

  @Get('followup-pathways')
  @ApiOperation({
    summary: 'Every pathway version, newest first',
    description: 'Old versions are kept because patients are still answering them.',
  })
  list(@CurrentActor() actor: AuthenticatedActor) {
    return this.pathways.listAll(actor);
  }

  @Post('followup-pathways/:code')
  @ApiOperation({
    summary: 'Publish a new version of a pathway (FR-13.7)',
    description:
      'Editing never mutates: this writes a NEW version and makes it current, leaving the old one exactly as it was for the patients part-way through it. Rules that name a question the set does not contain are refused — such a rule could never fire.',
  })
  publish(
    @Param('code') code: string,
    @Body() dto: PublishPathwayDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.pathways.publish(code, dto, actor);
  }

  @Get('safety-alerts/:alertId')
  @ApiOperation({ summary: 'One safety alert in full' })
  getAlert(@Param('alertId') alertId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.getOne(alertId, actor);
  }

  @Get('safety-alerts')
  @ApiOperation({
    summary: 'The safety queue (FR-18.5)',
    description: 'Everything open, oldest first. Care coordinators and clinical governance.',
  })
  queue(@Query() query: AlertQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.list(actor, query);
  }

  @Post('safety-alerts/:alertId/acknowledge')
  @ApiOperation({ summary: 'Take responsibility for an alert' })
  acknowledge(@Param('alertId') alertId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.alerts.acknowledge(alertId, actor);
  }

  @Post('safety-alerts/:alertId/close')
  @ApiOperation({ summary: 'Close an alert, saying what was done' })
  close(
    @Param('alertId') alertId: string,
    @Body() dto: CloseAlertDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.alerts.close(alertId, dto.closingNote, actor);
  }
}
