import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { AvailabilityService } from './availability.service';
import {
  BlockDateDto,
  CustomHoursDto,
  RemainingAvailabilityQueryDto,
  ReplaceWeeklyPatternDto,
  SlotLookupDto,
} from './dto/availability.dto';
import { SchedulingService } from './scheduling.service';

/**
 * A provider's own diary (FR-10.1).
 *
 * Every route carries `@VerifiedDoctorsOnly()`. Setting availability is part of
 * consulting - it is the act of offering to see patients - so it belongs behind
 * the same door as the rest of the provider experience, and an account an admin
 * has not approved yet has nothing to offer.
 *
 * There is no patient-facing route here on purpose. Since SRS 1.3 the patient
 * picks a service and a time, never a person, so "which slots can this service
 * cover" is assignment's question and belongs to M-11. What M-07 publishes to
 * the rest of the platform is `SchedulingService`, not an endpoint.
 */
@ApiTags('scheduling')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'me/doctor', version: '1' })
export class SchedulingController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly scheduling: SchedulingService,
  ) {}

  @Get('availability')
  @ApiOperation({
    summary: 'My weekly pattern, my leave and my date overrides',
    description:
      'Times are local to `timeZone`, which is the platform wall clock and not the device zone. `consultationDurationMinutes + bufferMinutes` is how much room one booking needs.',
  })
  getDiary(@CurrentActor() actor: AuthenticatedActor) {
    return this.availability.diaryOf(actor.id);
  }

  @Put('availability/weekly')
  @ApiOperation({
    summary: 'Replace my weekly pattern (FR-10.1)',
    description:
      'Sends the WHOLE pattern, not just the day that changed. An empty list clears it, which makes me unbookable for scheduled consultations.',
  })
  replaceWeekly(@Body() dto: ReplaceWeeklyPatternDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.availability.replaceWeekly(actor.id, dto.windows, actor);
  }

  @Post('availability/blocked')
  @ApiOperation({
    summary: 'Block a date, or part of one (FR-10.1)',
    description: 'No times means a whole day of leave. A block always beats the hours it covers.',
  })
  block(@Body() dto: BlockDateDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.availability.block(actor.id, dto, actor);
  }

  @Post('availability/custom-hours')
  @ApiOperation({
    summary: 'Different hours for one date (FR-10.1)',
    description: 'These REPLACE my weekly pattern for that date rather than adding to it.',
  })
  setCustomHours(@Body() dto: CustomHoursDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.availability.setCustomHours(actor.id, dto, actor);
  }

  @Delete('availability/:ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove one rule',
    description:
      'Rules are deleted, never deactivated: a diary states what is true now, and who changed it is the audit log.',
  })
  removeRule(@Param('ruleId') ruleId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.availability.removeRule(actor.id, ruleId, actor);
  }

  @Get('slots')
  @ApiOperation({
    summary: 'What my rules actually add up to',
    description:
      'Computed, never stored: my hours, minus leave and blocks, minus what is already booked. A start is offered only where the whole of duration plus buffer fits.',
  })
  slots(@Query() query: SlotLookupDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.scheduling.slotsFor(actor.id, new Date(query.from), new Date(query.to));
  }
}

/**
 * The panel's half (FR-10.1, FR-10.7).
 *
 * An admin edits any provider's diary through exactly the same service, because
 * an absent provider has to be removable from the pool without waiting for them
 * to update it themselves. `care_coordinator` and `operations` both reach it -
 * moving work around when somebody calls in sick is coordination, and refusing
 * it to the level that does that job daily would only mean nothing gets fixed.
 */
@ApiTags('admin/scheduling')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminSchedulingController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly scheduling: SchedulingService,
  ) {}

  @Get('doctors/:doctorId/availability')
  @ApiOperation({ summary: "A provider's diary as they set it" })
  getDiary(@Param('doctorId') doctorId: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.availability.diaryOf(doctorId);
  }

  @Put('doctors/:doctorId/availability/weekly')
  @ApiOperation({
    summary: "Replace a provider's weekly pattern (FR-10.1)",
    description: 'The audit entry names both the admin who changed it and whose diary it was.',
  })
  replaceWeekly(
    @Param('doctorId') doctorId: string,
    @Body() dto: ReplaceWeeklyPatternDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.availability.replaceWeekly(doctorId, dto.windows, actor);
  }

  @Post('doctors/:doctorId/availability/blocked')
  @ApiOperation({
    summary: 'Take a provider out of the pool for a day or a window (FR-10.1)',
    description:
      'The reason FR-10.1 gives the panel edit rights at all: a provider who calls in sick is blocked from here, not from their own app.',
  })
  block(
    @Param('doctorId') doctorId: string,
    @Body() dto: BlockDateDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.availability.block(doctorId, dto, actor);
  }

  @Post('doctors/:doctorId/availability/custom-hours')
  @ApiOperation({ summary: "Override one date's hours for a provider" })
  setCustomHours(
    @Param('doctorId') doctorId: string,
    @Body() dto: CustomHoursDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.availability.setCustomHours(doctorId, dto, actor);
  }

  @Delete('doctors/:doctorId/availability/:ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove one of a provider’s rules' })
  removeRule(
    @Param('doctorId') doctorId: string,
    @Param('ruleId') ruleId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.availability.removeRule(doctorId, ruleId, actor);
  }

  @Get('doctors/:doctorId/slots')
  @ApiOperation({ summary: 'The slots a provider is actually offering' })
  slots(
    @Param('doctorId') doctorId: string,
    @Query() query: SlotLookupDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator');
    return this.scheduling.slotsFor(doctorId, new Date(query.from), new Date(query.to));
  }

  @Get('availability/remaining')
  @ApiOperation({
    summary: 'Who is assignable for a service, language, region and time (FR-18.9, FR-10.7)',
    description:
      'The view an admin checks an allocation against before overriding it. Filters on the same inputs assignment uses (FR-20.2). `availableMinutes` is UNBROKEN time from `at`; `assignable` compares it with that provider’s duration plus buffer. Longest free run first.',
  })
  remaining(
    @Query() query: RemainingAvailabilityQueryDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'operations', 'care_coordinator', 'clinical_governance');
    return this.scheduling.remainingAcrossPool(
      { specialtyId: query.specialtyId, regionId: query.regionId, language: query.language },
      new Date(query.at),
    );
  }
}
