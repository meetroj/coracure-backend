import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Mirrors the `gender` enum. */
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;

/**
 * Launch is single-language (SRS 11 defers a multilingual app to Phase 3), but
 * FR-2.2 collects a preference and FR-4.4 filters doctors by language, so the
 * value has to be real rather than free text.
 */
export const LANGUAGES = ['en', 'hi'] as const;

/**
 * Every field optional: FR-2.2's profile is filled in over more than one
 * screen, and the account becomes `active` once name and date of birth are
 * both present. `mobileNumber` is absent on purpose - it is the sign-in
 * identifier and cannot be edited here.
 */
export class UpdatePatientProfileDto {
  @ApiPropertyOptional({ example: 'Anita Sharma' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  fullName?: string;

  @ApiPropertyOptional({
    example: '1990-04-17',
    description: 'YYYY-MM-DD. Age is derived from this and never stored.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsEnum(GENDERS)
  gender?: (typeof GENDERS)[number];

  @ApiPropertyOptional({
    enum: LANGUAGES,
    default: 'en',
    description:
      '*** MATCHED ON *** a provider who does not speak this is never assigned to this patient (FR-20.4).',
  })
  @IsOptional()
  @IsIn(LANGUAGES)
  preferredLanguage?: (typeof LANGUAGES)[number];

  @ApiPropertyOptional({
    description:
      'The state the patient is in, from `GET /regions` (FR-20.10). A preference assignment prefers and relaxes when the pool cannot cover the request - unlike language, which is never relaxed.',
  })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}
