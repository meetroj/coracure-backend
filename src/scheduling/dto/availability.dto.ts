import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { LANGUAGES } from '../../doctors/dto/doctor.dto';

/** Mirrors `consultation_channel`. In-person is out of scope (SRS section 11). */
export const CONSULTATION_CHANNELS = ['video', 'audio'] as const;

/**
 * `HH:MM`, 24-hour, in `PLATFORM_TIMEZONE`. `24:00` is accepted as an END only,
 * for a provider who works to midnight; Postgres `time` accepts it too, so the
 * value survives the round trip rather than being silently clipped to 23:59.
 */
const TIME_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const TIME_MESSAGE = 'must be a local time as HH:MM, e.g. 09:30';

/** `YYYY-MM-DD`, local. A calendar date, deliberately not an instant. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'must be a calendar date as YYYY-MM-DD';

export class WeeklyWindowDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 Sunday through 6 Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_OF_DAY, { message: `startTime ${TIME_MESSAGE}` })
  startTime!: string;

  @ApiProperty({ example: '17:00' })
  @Matches(TIME_OF_DAY, { message: `endTime ${TIME_MESSAGE}` })
  endTime!: string;

  @ApiPropertyOptional({
    enum: CONSULTATION_CHANNELS,
    isArray: true,
    default: CONSULTATION_CHANNELS,
    description: 'Which remote channels this window is offered on. Defaults to both.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(2)
  @IsIn(CONSULTATION_CHANNELS, { each: true })
  channels?: (typeof CONSULTATION_CHANNELS)[number][];
}

/**
 * The WHOLE weekly pattern, every time. Sending only the day that changed would
 * leave the other days as they were, and a provider who meant to clear their
 * Fridays would still be bookable on them.
 */
export class ReplaceWeeklyPatternDto {
  @ApiProperty({
    type: [WeeklyWindowDto],
    description: 'Replaces the standing pattern outright. An empty list clears it.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowDto)
  windows!: WeeklyWindowDto[];
}

export class BlockDateDto {
  @ApiProperty({ example: '2026-09-14' })
  @Matches(CALENDAR_DATE, { message: `date ${DATE_MESSAGE}` })
  date!: string;

  @ApiPropertyOptional({
    example: '13:00',
    description: 'Omit BOTH times for a whole day of leave. Send both to block part of a day.',
  })
  @IsOptional()
  @Matches(TIME_OF_DAY, { message: `startTime ${TIME_MESSAGE}` })
  startTime?: string;

  @ApiPropertyOptional({ example: '15:00' })
  @IsOptional()
  @Matches(TIME_OF_DAY, { message: `endTime ${TIME_MESSAGE}` })
  endTime?: string;

  @ApiPropertyOptional({
    enum: CONSULTATION_CHANNELS,
    isArray: true,
    default: CONSULTATION_CHANNELS,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(2)
  @IsIn(CONSULTATION_CHANNELS, { each: true })
  channels?: (typeof CONSULTATION_CHANNELS)[number][];
}

export class CustomHoursDto {
  @ApiProperty({ example: '2026-09-14' })
  @Matches(CALENDAR_DATE, { message: `date ${DATE_MESSAGE}` })
  date!: string;

  @ApiProperty({ example: '14:00', description: 'REPLACES the weekly pattern for this date' })
  @Matches(TIME_OF_DAY, { message: `startTime ${TIME_MESSAGE}` })
  startTime!: string;

  @ApiProperty({ example: '18:00' })
  @Matches(TIME_OF_DAY, { message: `endTime ${TIME_MESSAGE}` })
  endTime!: string;

  @ApiPropertyOptional({
    enum: CONSULTATION_CHANNELS,
    isArray: true,
    default: CONSULTATION_CHANNELS,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(2)
  @IsIn(CONSULTATION_CHANNELS, { each: true })
  channels?: (typeof CONSULTATION_CHANNELS)[number][];
}

export class SlotLookupDto {
  @ApiProperty({ example: '2026-09-14T00:00:00.000Z', description: 'An instant, not a local date' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ example: '2026-09-21T00:00:00.000Z' })
  @IsISO8601()
  to!: string;
}

/** FR-10.7's admin view: how long each provider of a service is free for, at one moment. */
export class RemainingAvailabilityQueryDto {
  @ApiProperty({
    example: '2026-09-14T09:30:00.000Z',
    description:
      'The moment to measure from. Usually the slot an admin is checking an override against.',
  })
  @IsISO8601()
  at!: string;

  @ApiPropertyOptional({ description: 'Narrows the pool to providers of one service' })
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  /**
   * *** THE ONE INPUT ASSIGNMENT CANNOT RELAX. *** FR-20.4 makes language a hard
   * requirement, so an admin checking or overriding an allocation (FR-18.9) has
   * to be able to see the pool the way assignment sees it. Without this the
   * panel would show providers who could never have been assigned to that
   * patient, which is the opposite of what an override screen is for.
   */
  @ApiPropertyOptional({
    enum: LANGUAGES,
    description: 'Narrows the pool to providers who speak it. Never relaxed (FR-20.4).',
  })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: (typeof LANGUAGES)[number];

  @ApiPropertyOptional({ description: 'Narrows it further to providers serving one region' })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}
