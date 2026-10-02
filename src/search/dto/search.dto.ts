import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The query travels in a POST body, not a query string.
 *
 * FR-5.11 keeps searches off the server, and a GET would defeat that on its own
 * - the text would sit in access logs, proxy logs and browser history whatever
 * this service chose to store. What a patient types about their mental health
 * is the last thing that should end up somewhere nobody meant to keep it.
 */
export class SearchQueryDto {
  @ApiProperty({
    example: 'neend nahi aati aur ghabrahat hoti hai',
    description: 'Plain words - English, Hindi, or the two mixed. Typed or spoken (FR-5.10).',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(400)
  query!: string;
}

export class UpdateCrisisKeywordsDto {
  @ApiProperty({
    type: [String],
    example: ['kill myself', 'khudkushi', 'आत्महत्या'],
    description:
      'Whole phrases, matched on word boundaries. Clinically approved content (SRS 8) - an emptied list is a guardrail that never fires.',
  })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  keywords!: string[];
}

export class UpdateSynonymsDto {
  @ApiProperty({
    example: { neend: ['sleep'], ghabrahat: ['anxiety', 'panic'] },
    description:
      'Read in BOTH directions, so a concern phrased either way is reachable from either query.',
  })
  @IsObject()
  synonyms!: Record<string, string[]>;
}

export class UpdatePopularSearchesDto {
  @ApiProperty({ type: [String], example: ['trouble sleeping', 'feeling low'] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  popular!: string[];
}

export class HelplineDto {
  @ApiProperty({ example: 'Tele-MANAS (national mental health helpline)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ example: '14416' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  number!: string;

  @ApiProperty({ required: false, example: '24x7' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  available?: string;
}

/**
 * FR-5.6's guidance. SRS section 8 makes this wording the client's to approve,
 * and every number theirs to confirm - a helpline that has changed number is
 * worse than no helpline at all.
 */
export class UpdateEmergencyGuidanceDto {
  @ApiProperty({ example: 'Help is available right now' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;

  @ApiProperty({
    type: [HelplineDto],
    description: 'At least one - the screen cannot be a dead end',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HelplineDto)
  helplines!: HelplineDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  footer?: string;
}

export class UpdateDisclaimerDto {
  @ApiProperty({
    description: 'FR-5.8: states plainly that this does not screen, diagnose or decide treatment',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(600)
  disclaimer!: string;
}
