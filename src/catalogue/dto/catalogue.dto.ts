import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
 
import { DOCTOR_DOCUMENT_TYPES } from '../../doctors/dto/doctor.dto';
import { TIE_BREAKS } from '../allocation-policy.service';

/** Mirrors `provider_type`. Which registration form a specialty's providers use. */
export const PROVIDER_TYPES = ['doctor', 'non_doctor'] as const;

/** Lowercase, stable, and the handle the apps and seeds refer to a row by. */
const CODE = /^[a-z][a-z0-9_]{1,59}$/;

export class CreateSpecialtyDto {
  @ApiProperty({ example: 'psychiatry', description: 'Stable lowercase handle' })
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code!: string;

  @ApiProperty({ example: 'Psychiatry' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    enum: PROVIDER_TYPES,
    description: 'Which registration form providers of this specialty are created on (FR-19.7)',
  })
  @IsEnum(PROVIDER_TYPES)
  providerType!: (typeof PROVIDER_TYPES)[number];

  @ApiPropertyOptional({
    default: false,
    description: 'Only a `doctor` specialty may prescribe. A CHECK enforces the same rule.',
  })
  @IsOptional()
  @IsBoolean()
  canPrescribe?: boolean;

  @ApiProperty({ example: 800, description: 'What the PATIENT pays for this service (FR-7.8)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  consultationFeeInr!: number;

  @ApiPropertyOptional({
    description: 'Ordered field list: key, label, input type, options, required',
  })
  @IsOptional()
  @IsObject()
  intakeForm?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'The medical-history block, asked only on a first consultation',
  })
  @IsOptional()
  @IsObject()
  firstConsultForm?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: DOCTOR_DOCUMENT_TYPES,
    isArray: true,
    description:
      'What a provider of this specialty must submit ON TOP OF the platform baseline. The baseline is always required; this can only ask for more.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(DOCTOR_DOCUMENT_TYPES, { each: true })
  requiredDocuments?: (typeof DOCTOR_DOCUMENT_TYPES)[number][];
}

export class UpdateSpecialtyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: PROVIDER_TYPES })
  @IsOptional()
  @IsEnum(PROVIDER_TYPES)
  providerType?: (typeof PROVIDER_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canPrescribe?: boolean;

  @ApiPropertyOptional({ description: 'Applies to the next booking; issued invoices are frozen' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  consultationFeeInr?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  intakeForm?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  firstConsultForm?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: DOCTOR_DOCUMENT_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(DOCTOR_DOCUMENT_TYPES, { each: true })
  requiredDocuments?: (typeof DOCTOR_DOCUMENT_TYPES)[number][];

  @ApiPropertyOptional({ description: 'Refused while listed providers are registered under it' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateConcernDto {
  @ApiProperty()
  @IsUUID()
  specialtyId!: string;

  @ApiProperty({ example: 'sleep' })
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code!: string;

  @ApiProperty({ example: 'Sleep problems', description: 'Also the match reason FR-5.4 shows' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    example: ['cant sleep', 'neend nahi aati', 'insomnia'],
    description: 'English, Hindi and mixed. Edited from the panel with no release.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  matchPhrases?: string[];

  @ApiPropertyOptional({ default: 1, description: 'Breaks a ranking tie between concerns' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  matchWeight?: number;
}

export class UpdateConcernDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  matchPhrases?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  matchWeight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateRegionDto {
  @ApiProperty({ example: 'karnataka', description: 'A state or province (FR-20.11)' })
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code!: string;

  @ApiProperty({ example: 'Karnataka' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

export class UpdateRegionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CODE, { message: 'code must be lowercase letters, digits and underscores' })
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Refused while providers still serve this region' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * SRS 4.20. Note what is absent: there is no setting that relaxes LANGUAGE.
 * A provider who cannot speak to the patient is never assigned to them, and
 * that is not an admin's to change.
 */
export class UpdateAllocationPolicyDto {
  @ApiPropertyOptional({
    description:
      'True lets assignment go outside the patient region when nobody in it is free, recording that it did (FR-20.5).',
  })
  @IsOptional()
  @IsBoolean()
  regionRelaxable?: boolean;

  @ApiPropertyOptional({
    enum: TIE_BREAKS,
    description: 'How ties are broken across a pool (FR-20.6)',
  })
  @IsOptional()
  @IsIn(TIE_BREAKS)
  tieBreak?: (typeof TIE_BREAKS)[number];

  @ApiPropertyOptional({
    description: 'How many times one patient may decline an assignment (FR-4.4)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxPatientDeclines?: number;
}
