import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Mirrors `consultation_channel`. In-person is out of scope (SRS section 11). */
export const CONSULTATION_CHANNELS = ['video', 'audio'] as const;

export class BookScheduledDto {
  @ApiProperty({ description: 'The SERVICE, from GET /services. Never a provider.' })
  @IsUUID()
  specialtyId!: string;

  @ApiPropertyOptional({ description: 'What the search mapped the query onto' })
  @IsOptional()
  @IsUUID()
  concernId?: string;

  @ApiProperty({
    example: '2026-09-14T09:30:00.000Z',
    description: 'A start the pool can cover, from the slots the service offers',
  })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional({
    enum: CONSULTATION_CHANNELS,
    default: 'video',
    description: 'Video or audio call. Not yet checked against the assigned slot’s own channels.',
  })
  @IsOptional()
  @IsIn(CONSULTATION_CHANNELS)
  channel?: (typeof CONSULTATION_CHANNELS)[number];

  @ApiPropertyOptional({
    description:
      'Answers to the specialty’s intake form, including its free-text field. Snapshotted onto the booking.',
  })
  @IsOptional()
  @IsObject()
  intakeAnswers?: Record<string, unknown>;
}

export class RequestInstantDto {
  @ApiProperty()
  @IsUUID()
  specialtyId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  concernId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  intakeAnswers?: Record<string, unknown>;
}

export class CancelConsultationDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class RescheduleDto {
  @ApiProperty({ example: '2026-09-16T11:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;
}

/**
 * FR-4.4. The reason is required, not optional: it is what makes a provider
 * declined repeatedly visible to the client rather than invisible, and a decline
 * with no reason tells nobody anything.
 */
export class DeclineProviderDto {
  @ApiProperty({
    example: 'I would prefer to speak to someone I have seen before.',
    description: 'Recorded against the booking. Shown in the allocation views.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}

/** FR-20.8. The one path that names a provider directly, and only an admin has it. */
export class OverrideProviderDto {
  @ApiProperty()
  @IsUUID()
  doctorId!: string;

  @ApiProperty({
    example: 'Patient asked for a female provider; reassigned after speaking to them.',
    description: 'Required. The override, its reason and the admin are written to the audit log.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}

export class ListConsultationsQueryDto {
  @ApiPropertyOptional({
    default: true,
    description: 'True for what is still to come, false for what has been',
  })
  @IsOptional()
  // `obj`, not `value`: implicit conversion has already turned the string 'false' into true by here.
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.upcoming !== 'false' && obj.upcoming !== false)
  @IsBoolean()
  upcoming?: boolean;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
