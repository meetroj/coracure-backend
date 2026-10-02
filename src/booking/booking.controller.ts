import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { BookingService } from './booking.service';
import {
  BookScheduledDto,
  CancelConsultationDto,
  DeclineProviderDto,
  ListConsultationsQueryDto,
  OverrideProviderDto,
  RequestInstantDto,
  RescheduleDto,
} from './dto/booking.dto';

/** 
 * The patient's bookings (FR-4.6).
 *
 * *** THERE IS NO ENDPOINT THAT TAKES A PROVIDER. *** FR-20.1 says a patient
 * cannot choose, request or be shown a choice of provider, and the shape of this
 * controller is where that is enforced: `specialtyId` and a time go in, and who
 * they will see comes back. The only way to name a provider anywhere in M-11 is
 * the admin override below.
 */
@ApiTags('booking')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations', version: '1' })
export class PatientBookingController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  @ApiOperation({
    summary: 'My consultations, upcoming or past (FR-6.5)',
    description:
      'Upcoming is everything still holding time: held, scheduled or awaiting a provider.',
  })
  list(@Query() query: ListConsultationsQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.listFor(actor, query);
  }

  @Get(':consultationId')
  @ApiOperation({ summary: 'One of my consultations' })
  get(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.getForActor(id, actor);
  }

  @Post()
  @ApiOperation({
    summary: 'Book a scheduled consultation (FR-6.1)',
    description:
      'Pick a SERVICE and a time; the provider is assigned (SRS 4.20). Returns `pending_payment` with a `holdExpiresAt` — the row IS the slot hold, and it is released if checkout is abandoned. A free service is booked outright. Refused with `NO_PROVIDER_AVAILABLE` and the soonest the pool can cover, rather than any fallback to somebody who does not match.',
  })
  book(@Body() dto: BookScheduledDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.bookScheduled(
      actor.id,
      { ...dto, startsAt: new Date(dto.startsAt) },
      actor,
    );
  }

  @Post('instant')
  @ApiOperation({
    summary: 'Consult Now (FR-6.1)',
    description:
      'Creates the request with no provider yet. M-13 offers it, times it out and re-routes it by the same assignment rules.',
  })
  instant(@Body() dto: RequestInstantDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.requestInstant(actor.id, dto, actor);
  }

  @Post(':consultationId/decline-provider')
  @ApiOperation({
    summary: 'Ask for a different provider (FR-4.4)',
    description:
      'Up to the configured limit per booking. The reason is required and recorded, so a provider declined repeatedly is visible to the client rather than invisible. Past the limit, continue with the provider assigned or cancel.',
  })
  decline(
    @Param('consultationId') id: string,
    @Body() dto: DeclineProviderDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.booking.declineProvider(id, actor.id, dto.reason);
  }

  @Post(':consultationId/cancel')
  @ApiOperation({ summary: 'Cancel (FR-6.4)', description: 'Refund status is M-12’s to report.' })
  cancel(
    @Param('consultationId') id: string,
    @Body() dto: CancelConsultationDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.booking.cancel(id, actor, dto.reason);
  }

  @Post(':consultationId/reschedule')
  @ApiOperation({
    summary: 'Move to another time (FR-6.4)',
    description:
      'Creates a NEW consultation linked back to this one and cancels this one. The provider is assigned again from scratch: whoever was free on Tuesday may not be free on Thursday.',
  })
  reschedule(
    @Param('consultationId') id: string,
    @Body() dto: RescheduleDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.booking.reschedule(id, new Date(dto.startsAt), actor);
  }
}

/** The provider's side of the same rows. */
@ApiTags('booking')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor/consultations', version: '1' })
export class DoctorBookingController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  @ApiOperation({ summary: 'My consultations, upcoming or past (FR-9.1)' })
  list(@Query() query: ListConsultationsQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.listFor(actor, query);
  }

  @Get(':consultationId')
  @ApiOperation({ summary: 'One of my consultations' })
  get(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.getForActor(id, actor);
  }

  @Post(':consultationId/no-show')
  @ApiOperation({
    summary: 'Mark that the patient did not attend',
    description:
      'There is no `no_show_party` column: which party missed it is the one with no participant row (M-14).',
  })
  noShow(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.booking.markNoShow(id, actor);
  }

  @Post(':consultationId/cancel')
  @ApiOperation({ summary: 'Cancel a consultation I cannot take' })
  cancel(
    @Param('consultationId') id: string,
    @Body() dto: CancelConsultationDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.booking.cancel(id, actor, dto.reason);
  }
}

/**
 * FR-20.8 and FR-18.9: the panel's half.
 *
 * `operations` and `care_coordinator`, the same pair that maintains the pools
 * and reads the assignability view in M-07 — overriding an allocation is the
 * action those two views exist to inform.
 */
@ApiTags('admin/booking')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/consultations', version: '1' })
export class AdminBookingController {
  constructor(private readonly booking: BookingService) {}

  @Get(':consultationId')
  @ApiOperation({ summary: 'One consultation' })
  get(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'care_coordinator', 'clinical_governance');
    return this.booking.getForActor(id, actor);
  }

  @Post(':consultationId/override-provider')
  @ApiOperation({
    summary: 'Reassign to a named provider (FR-20.8)',
    description:
      'The override, its reason and the admin who made it are written to the audit log. Still refused if that provider is not free for the whole slot — an override is a judgement about WHO, not a licence to double-book.',
  })
  override(
    @Param('consultationId') id: string,
    @Body() dto: OverrideProviderDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.booking.overrideProvider(id, dto.doctorId, dto.reason, actor);
  }

  @Post(':consultationId/cancel')
  @ApiOperation({ summary: 'Cancel on a patient’s behalf' })
  cancel(
    @Param('consultationId') id: string,
    @Body() dto: CancelConsultationDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.booking.cancel(id, actor, dto.reason);
  }
}
