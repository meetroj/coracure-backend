import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RiskCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * A prescription is a long list only when something has gone wrong with the
 * form. The ceiling is a guard on the payload, not a clinical opinion.
 */
export const MAX_MEDICINE_LINES = 30;
export const MAX_RECOMMENDED_CONTENT = 20;

/** One line of FR-9.5's structured prescription form. */
export class MedicineDto {
  @ApiPropertyOptional({
    description:
      'This line’s own id, as returned by a previous save. Send it back to edit that line rather than add a new one; omit it on a new line and one is assigned on save.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Sertraline 50mg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: '1 tablet' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  dose!: string;

  @ApiProperty({ example: 'Once daily, in the morning' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  frequency!: string;

  @ApiProperty({ example: '4 weeks' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  duration!: string;

  @ApiPropertyOptional({ example: 'Take after food. Do not stop abruptly.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  @ApiPropertyOptional({ example: 'Sertraline' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  genericName?: string;

  @ApiPropertyOptional({ example: 'Oral' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  route?: string;

  @ApiPropertyOptional({ example: '30 tablets' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  quantity?: string;
}

/**
 * The whole record, saved as a draft as often as the doctor likes.
 *
 * Every field but the chief complaint and the risk category is optional,
 * because a doctor writes this up over the course of a consultation rather than
 * in one submission. What makes a record COMPLETE is a separate question,
 * asked only when finalising - see `completion.ts` and FR-11.5.
 */
export class SaveClinicalRecordDto {
  @ApiProperty({ example: 'Low mood and poor sleep for three weeks.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  chiefComplaint!: string;

  @ApiProperty({ enum: RiskCategory, description: 'FR-11.1. Drives follow-up urgency.' })
  @IsEnum(RiskCategory)
  riskCategory!: RiskCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  clinicalHistory?: string;

  @ApiPropertyOptional({ description: 'Diagnosis, or provisional diagnosis.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  diagnosis?: string;

  @ApiPropertyOptional({
    description:
      'Defaults to true. A provisional diagnosis is the norm in a first teleconsultation.',
  })
  @IsOptional()
  @IsBoolean()
  isDiagnosisProvisional?: boolean;

  @ApiPropertyOptional({
    description:
      'What an in-person or emergency referral is FOR. Writing it IS advising the referral — there is no separate flag, because a flag beside the note could contradict it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  referralNote?: string;

  @ApiPropertyOptional({
    type: [MedicineDto],
    description:
      'Refused unless the treating professional’s specialty may prescribe (FR-4.3). Their closing record is the advice and therapy plan instead.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDICINE_LINES)
  @ValidateNested({ each: true })
  @Type(() => MedicineDto)
  medicines?: MedicineDto[];

  @ApiPropertyOptional({ description: 'What was covered this session.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  adviceCovered?: string;

  @ApiPropertyOptional({ description: 'Home practice for the patient.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  adviceHomePractice?: string;

  @ApiPropertyOptional({ description: 'The focus for the next session.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  adviceNextFocus?: string;

  @ApiPropertyOptional({ description: 'Shown on the patient’s Care Plan (FR-14.1).' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  adviceWarningSigns?: string;

  @ApiPropertyOptional({ description: 'FR-11.3. Three to five lines, one per line.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  caseSummary?: string;

  @ApiPropertyOptional({
    description:
      'Care Hub items picked for this patient (FR-15.4). Ids, not copies — the article may be revised and the patient should get the current text.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECOMMENDED_CONTENT)
  @IsUUID('4', { each: true })
  recommendedContentIds?: string[];
}
