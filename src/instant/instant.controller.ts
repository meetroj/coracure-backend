import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { SetPresenceDto } from './dto/instant.dto';
import { InstantRoutingService } from './instant-routing.service';
import { PresenceService } from './presence.service';

/**
 * The provider's Available Now controls (FR-10.2, FR-10.3, FR-10.4).
 *
 * `@VerifiedDoctorsOnly()` throughout: taking live requests is the most
 * consulting thing a provider does, so an unapproved account cannot reach any
 * of it.
 */
@ApiTags('instant')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'me/doctor', version: '1' })
export class DoctorPresenceController {
  constructor(
    private readonly presence: PresenceService,
    private readonly routing: InstantRoutingService,
  ) {}

  @Get('presence')
  @ApiOperation({
    summary: 'Where I am, and whether I can be sent a request',
    description:
      '`canReceiveInstant` needs three things at once: available now, permitted instant work by an admin, and no documentation outstanding (FR-10.5).',
  })
  get(@CurrentActor() actor: AuthenticatedActor) {
    return this.presence.of(actor.id);
  }

  @Put('presence')
  @ApiOperation({
    summary: 'Change my status (FR-10.4)',
    description:
      'Four of the seven states are mine to set. Going available is REFUSED while notes from a previous consultation are outstanding — being told is better than being available and receiving nothing.',
  })
  set(@Body() dto: SetPresenceDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.presence.set(actor.id, dto.presence, actor);
  }

  @Get('instant-requests')
  @ApiOperation({
    summary: 'Requests waiting on me right now',
    description: 'Each carries `expiresAt` — past it the request re-routes without me.',
  })
  openOffers(@CurrentActor() actor: AuthenticatedActor) {
    return this.routing.openOffersFor(actor.id);
  }

  @Post('instant-requests/:consultationId/accept')
  @ApiOperation({
    summary: 'Take an instant request (FR-10.2)',
    description:
      'First one to accept wins; every other open offer for the request is superseded. The patient then pays, and the call starts.',
  })
  accept(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.routing.accept(id, actor);
  }

  @Post('instant-requests/:consultationId/decline')
  @ApiOperation({
    summary: 'Pass on a request (FR-10.6)',
    description:
      'Re-routed to the next provider immediately, with no action from the patient — and by the same assignment rules as any other allocation, so language is never relaxed on a re-route.',
  })
  decline(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.routing.decline(id, actor);
  }
}

/** What the patient sees while their Consult Now request is being routed. */
@ApiTags('instant')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me/consultations/:consultationId', version: '1' })
export class PatientInstantController {
  constructor(private readonly routing: InstantRoutingService) {}

  @Get('instant-status')
  @ApiOperation({
    summary: 'How my Consult Now request is going',
    description:
      'The offers made so far, in order. The patient is never shown WHO was asked — only that the search is still running (SRS 4.2: a provider is an outcome, not a choice).',
  })
  async status(@Param('consultationId') id: string) {
    const offers = await this.routing.offersFor(id);
    return {
      attempts: offers.length,
      // Deliberately no doctor ids: the patient does not choose, so they are
      // not shown a list of people who said no.
      stillSearching: offers.some((offer) => offer.outcome === 'pending'),
      accepted: offers.some((offer) => offer.outcome === 'accepted'),
    };
  }
}

/**
 * FR-18.9's live view of the instant queue, and the routing trail behind one
 * request. `operations` and `care_coordinator` - the pair that already reads
 * the allocation views in M-07 and makes the overrides in M-11.
 */
@ApiTags('admin/instant')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/instant', version: '1' })
export class AdminInstantController {
  constructor(private readonly routing: InstantRoutingService) {}

  @Get('consultations/:consultationId/offers')
  @ApiOperation({
    summary: 'Who was asked, in what order, and what they said',
    description:
      'One row per provider offered. This is also the evidence behind FR-18.6’s acceptance rate, which is why no counter is cached on the provider row.',
  })
  offers(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'care_coordinator', 'clinical_governance');
    return this.routing.offersFor(id);
  }
}
