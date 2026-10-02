import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentItemType, ContentReviewStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ShelfQueryDto {
  @ApiPropertyOptional({ enum: ContentItemType })
  @IsOptional()
  @IsEnum(ContentItemType)
  itemType?: ContentItemType;

  @ApiPropertyOptional({ description: 'FR-15.2’s condition-wise shelving.' })
  @IsOptional()
  @IsUUID()
  concernId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @ApiPropertyOptional({
    description:
      'FR-15.6. Verified organisations only — a helpline list read by somebody in distress has to be filterable.',
  })
  @IsOptional()
  @IsBoolean()
  verifiedOnly?: boolean;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AdminContentQueryDto {
  @ApiPropertyOptional({ enum: ContentItemType })
  @IsOptional()
  @IsEnum(ContentItemType)
  itemType?: ContentItemType;

  @ApiPropertyOptional({ enum: ContentReviewStatus })
  @IsOptional()
  @IsEnum(ContentReviewStatus)
  reviewStatus?: ContentReviewStatus;
}

export class ContentInputDto {
  @ApiProperty({ enum: ContentItemType })
  @IsEnum(ContentItemType)
  itemType!: ContentItemType;

  @ApiProperty({
    example: 'box-breathing',
    description: 'Lowercase words separated by single hyphens. It goes into a link.',
  })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase words separated by single hyphens',
  })
  @MaxLength(160)
  slug!: string;

  @ApiProperty({ example: 'Box breathing' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'A four-count breathing exercise for acute anxiety.' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  summary?: string;

  @ApiProperty({
    description:
      'Structured blocks. For a `support_org` this holds the phone, address and timings FR-15.6 asks for.',
    example: { blocks: [{ type: 'paragraph', text: 'Breathe in for four counts…' }] },
  })
  @IsObject()
  body!: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  concernId?: string;

  @ApiPropertyOptional({ description: 'Used by `clinical_reference`.' })
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @ApiPropertyOptional({
    description:
      'Object-store key for the cover image. NOT a patient file — content media is public and has no patient owner.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  coverStorageKey?: string;

  @ApiPropertyOptional({
    description:
      'FR-15.6. Required for `support_org` and refused on everything else — verification is meaningless on a blog post.',
  })
  @IsOptional()
  @IsBoolean()
  isVerifiedOrg?: boolean;

  @ApiPropertyOptional({ example: 0, description: 'Shelf order. Ties break on creation time.' })
  @IsOptional()
  @IsInt()
  @Min(-32768)
  @Max(32767)
  sortOrder?: number;
}
