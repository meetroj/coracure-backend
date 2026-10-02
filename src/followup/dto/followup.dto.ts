import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SafetyAlertType } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** FR-9.7. The doctor assigns the pathway, the start date and any extra questions. */
export class AssignFollowupDto {
  @ApiProperty({ example: 'depression_anxiety' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  pathwayCode!: string;

  @ApiPropertyOptional({
    description:
      'Defaults to tomorrow. A check-in on the day of the consultation asks how today compares with a day that contained the appointment, which answers nothing.',
    example: '2026-09-15',
  })
  @IsOptional()
  @IsDateString()
  startsOn?: string;

  @ApiPropertyOptional({
    description:
      'FR-13.8. Questions for THIS patient only. They collect answers and carry no red-flag rules, so safety alerting stays on the clinician-approved set.',
  })
  @IsOptional()
  @IsArray()
  extraQuestions?: unknown[];
}

export class SubmitCheckinDto {
  @ApiProperty({
    description: 'Keyed by question id, as returned by the check-in endpoint.',
    example: { mood: 'worse', self_harm: 'no', feeling_unsafe: 'no' },
  })
  @IsObject()
  answers!: Record<string, unknown>;
}

/** Admin-authored clinical content (FR-13.7). Saving publishes a NEW version. */
export class PublishPathwayDto {
  @ApiProperty({ example: 'Depression and anxiety' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 7, description: 'The follow-up window, in days.' })
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ApiProperty({
    description:
      'The ordered question set. Each option carries the status it contributes; `red` is not an option flag, because a red status comes only from a rule that carries its reason.',
  })
  @IsArray()
  questions!: unknown[];

  @ApiProperty({
    description:
      'FR-13.5. Every rule must name a question that exists in the set — a rule pointing at a missing question could never fire, which is the worst failure available here.',
  })
  @IsArray()
  redFlagRules!: unknown[];
}

export class AlertQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to open alerts only.' })
  @IsOptional()
  @IsBoolean()
  openOnly?: boolean;

  @ApiPropertyOptional({ enum: SafetyAlertType })
  @IsOptional()
  @IsEnum(SafetyAlertType)
  alertType?: SafetyAlertType;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CloseAlertDto {
  @ApiProperty({
    description:
      'What was done about it. This is the answer to "what happened about this" months later, so it is required.',
    example: 'Called the patient, reviewed medication, brought the follow-up forward to tomorrow.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  closingNote!: string;
}

/** A pathway code as the URL carries it. */
export class PathwayCodeParam {
  @Matches(/^[a-z0-9_]{2,60}$/)
  code!: string;
}
