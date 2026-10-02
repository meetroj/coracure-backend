import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InboxQueryDto {
  @ApiPropertyOptional({ default: false, description: 'Only what has not been read yet' })
  @IsOptional()
  // `obj`, not `value`: implicit conversion has already turned the string 'false' into true by here.
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.unreadOnly === true || obj.unreadOnly === 'true')
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Page back by passing the `createdAt` of the oldest row you already have',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;
}

/**
 * What an admin may change about a template: the words, and only the words
 * (FR-16.3). The audience and the variable list are behaviour, not copy, so
 * they stay in the build where they can be type-checked.
 */
export class UpdateTemplateDto {
  @ApiProperty({
    example: 'Your consultation is confirmed',
    description: 'May use only the placeholders this template declares',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    example: 'Your consultation with {{doctorName}} is confirmed for {{consultationTime}}.',
    description: 'Refused if it names a diagnosis (FR-16.2) or uses a variable this template lacks',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
