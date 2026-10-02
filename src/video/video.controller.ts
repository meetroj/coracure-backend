import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { Public } from '../identity/public.decorator';
import { VideoService } from './video.service';

/**
 * The consultation call, from whichever side is asking (FR-8.1 to FR-8.6).
 *
 * ONE controller for both parties, because both do exactly the same three
 * things: check they can join, join, and read what happened. Which side the
 * caller is on is decided from the consultation row rather than from the route,
 * so there is no path a patient could take to be issued a doctor's token.
 *
 * `@VerifiedDoctorsOnly()` because a call is the core of the doctor experience:
 * it reads the row rather than the token, so a provider whose approval is
 * withdrawn cannot join a call on a session issued before that happened.
 */
@ApiTags('video')
@ApiBearerAuth()
@Roles('patient', 'doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'consultations/:consultationId/video', version: '1' })
export class VideoController {
  constructor(private readonly video: VideoService) {}

  @Get('readiness')
  @ApiOperation({
    summary: 'Can I join this consultation, and where (FR-8.2)',
    description:
      'The pre-call check, answered without issuing anything. Returns the LiveKit URL and whether Join would work — so the app can run its camera, microphone and network checks first without burning a token that expires in minutes.',
  })
  readiness(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.video.readiness(id, actor);
  }

  @Post('token')
  @ApiOperation({
    summary: 'A join token for this consultation (FR-8.5)',
    description:
      'Short-lived, scoped to this one room, and issued only to the assigned patient and the assigned doctor after consent and payment pass. Not stored — a second call issues a second token, and the issue of each is an audit entry.',
  })
  token(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.video.issueJoinToken(id, actor);
  }

  @Get('session')
  @ApiOperation({
    summary: 'What happened on the call (FR-8.6)',
    description:
      'One entry per connection, so a mid-consult reconnect is visible rather than hidden. The session start, end, call duration and which party did not show are all computed from those entries and none is stored. No video or audio is recorded.',
  })
  session(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.video.sessionFor(id, actor);
  }
}

/**
 * *** THE WEBHOOK. THE ONLY WRITER OF `consultation_participants`. ***
 *
 * `@Public()` because LiveKit has no bearer token — its identity IS the signed
 * `Authorization` JWT over the body, which is checked before any field is read.
 * That makes the signature the whole of the authentication.
 *
 * The RAW body is used, not the parsed one: the signature covers a hash of the
 * bytes that were sent, and re-serialising JSON changes key order and spacing.
 */
@ApiTags('video')
@Controller({ path: 'video', version: '1' })
export class VideoWebhookController {
  constructor(private readonly video: VideoService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  handle(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('authorization') authorization?: string,
  ) {
    // An empty body or a missing header still goes through verification, so a
    // caller cannot tell "not signed" from "signed wrongly" by the response.
    return this.video.handleWebhook(request.rawBody?.toString('utf8') ?? '', authorization ?? '');
  }
}

/** Reading a call, for the panel. Never joining one — no admin is issued a token. */
@ApiTags('admin/video')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/consultations/:consultationId/video', version: '1' })
export class AdminVideoController {
  constructor(private readonly video: VideoService) {}

  @Get('session')
  @ApiOperation({
    summary: 'The session record, for adjudicating a complaint or a refund',
    description:
      "`disconnectReason` is LiveKit's own, verbatim: it is what separates a party who hung up from one whose network dropped, which is the question a technical-issue complaint turns on.",
  })
  session(@Param('consultationId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.video.sessionForAdmin(id, actor);
  }
}
