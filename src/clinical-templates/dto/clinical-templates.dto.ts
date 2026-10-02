import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MAX_MEDICINE_LINES } from '../../clinical/dto/clinical.dto';

export const MAX_TEMPLATE_LINES = 30;
export const TEMPLATE_KINDS = ['medication', 'advice', 'therapy', 'followUp'] as const;

/**
 * A medicine line, exactly the shape and caps of the clinical record's
 * `MedicineDto` (minus its per-save `id`), so applying a template and saving
 * the record can never be a 400.
 */
export class TemplateMedicineDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  genericName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  route?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  quantity?: string;
}

export class TemplateContentDto {
  @ApiProperty({ type: [TemplateMedicineDto] })
  @IsArray()
  @ArrayMaxSize(MAX_MEDICINE_LINES)
  @ValidateNested({ each: true })
  @Type(() => TemplateMedicineDto)
  meds!: TemplateMedicineDto[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_TEMPLATE_LINES)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  advice!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(MAX_TEMPLATE_LINES)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  donts!: string[];
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'Anxiety initial care' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ enum: TEMPLATE_KINDS })
  @IsIn(TEMPLATE_KINDS)
  kind!: (typeof TEMPLATE_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  specialty?: string;

  @ApiProperty({ type: TemplateContentDto })
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content!: TemplateContentDto;
}

/** Same fields, all optional: send only what changed. */
export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ enum: TEMPLATE_KINDS })
  @IsOptional()
  @IsIn(TEMPLATE_KINDS)
  kind?: (typeof TEMPLATE_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  specialty?: string;

  @ApiPropertyOptional({ type: TemplateContentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content?: TemplateContentDto;
}
