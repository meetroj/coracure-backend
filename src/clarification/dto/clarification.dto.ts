import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClarificationUrgency, Gender } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { MESSAGE_TYPES, MessageType } from '../thread';

/**
 * FR-12.3's fields.
 *
 * *** THERE IS NO NAME, PHONE, ADDRESS OR EMAIL FIELD, AND THERE NEVER WILL BE. ***
 * Age and gender are the only patient attributes a reviewer needs, and neither
 * identifies anybody alone. The free text is scanned for identifiers on the way
 * in and again at post — see `deidentify.ts`.
 */
export class CaseInputDto {
  @ApiProperty({ example: 'Persistent low mood despite two SSRI trials' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    example: 'Drug interaction',
    description:
      'A free-text guidance area. Not one of FR-12.3’s fields; scanned for identifiers like the rest.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  topic?: string;

  @ApiPropertyOptional({ example: 34 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  patientAge?: number;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  patientGender?: Gender;

  @ApiProperty({ description: 'The clinical history, in your own words. No names.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  briefHistory!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  diagnosis?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  currentPlan?: string;

  @ApiProperty({ description: 'The specific thing you want an opinion on.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  specificDoubt!: string;

  @ApiPropertyOptional({ enum: ClarificationUrgency, default: 'routine' })
  @IsOptional()
  @IsEnum(ClarificationUrgency)
  urgency?: ClarificationUrgency;

  @ApiPropertyOptional({
    description:
      'Your own reference back to the consultation. Recorded for you and the audit trail, and NEVER shown to the reviewer.',
  })
  @IsOptional()
  @IsUUID()
  sourceConsultationId?: string;
}

/** FR-12.5. The kind is what the treating doctor triages by, so it is required. */
export class ExpertReplyDto {
  @ApiProperty({
    enum: MESSAGE_TYPES,
    description:
      '`clarification_request` puts the case back on the author’s desk; everything else puts an answer on it.',
  })
  @IsEnum(MESSAGE_TYPES)
  messageType!: MessageType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

export class AuthorReplyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

export class AssignExpertDto {
  @ApiProperty({ description: 'Must be a verified doctor at `expert` seniority.' })
  @IsUUID()
  expertDoctorId!: string;
}

export class CaseListQueryDto {
  @ApiPropertyOptional({ description: 'Hide closed cases.' })
  @IsOptional()
  @IsBoolean()
  openOnly?: boolean;
}
