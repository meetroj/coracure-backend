import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ComplaintCategory, ComplaintStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** FR-17.1. */
export class SubmitFeedbackDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 4 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({ description: 'Optional. The patient’s own words.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/** FR-17.2. */
export class RaiseComplaintDto {
  @ApiProperty({ enum: ComplaintCategory })
  @IsEnum(ComplaintCategory)
  category!: ComplaintCategory;

  @ApiProperty({ example: 'The provider joined 20 minutes late' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  description!: string;

  @ApiPropertyOptional({
    description:
      'The consultation this is about, if it is about one. Only your own may be named. Leave it out for a billing or app problem.',
  })
  @IsOptional()
  @IsUUID()
  consultationId?: string;
}

export class ComplaintReplyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

export class AdminComplaintReplyDto extends ComplaintReplyDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'An INTERNAL note is never shown to the patient — somewhere to record "spoke to the provider, they dispute this" that the next admin to open the ticket can read.',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class CloseComplaintDto {
  @ApiProperty({
    enum: ['resolved', 'rejected'],
    description:
      '`resolved` means something was done. `rejected` means it was considered and declined — a different outcome, and one the patient is owed as a distinct answer.',
  })
  @IsIn(['resolved', 'rejected'])
  outcome!: 'resolved' | 'rejected';

  @ApiProperty({
    description:
      'What was decided and why. Required for BOTH endings: the patient reads this, and so does anyone who picks the case up later.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  resolutionNote!: string;
}

export class AssignComplaintDto {
  @ApiProperty({ description: 'The admin who will work it.' })
  @IsUUID()
  assignToAdminId!: string;
}

export class ComplaintQueryDto {
  @ApiPropertyOptional({ enum: ComplaintStatus })
  @IsOptional()
  @IsEnum(ComplaintStatus)
  status?: ComplaintStatus;

  @ApiPropertyOptional({ enum: ComplaintCategory })
  @IsOptional()
  @IsEnum(ComplaintCategory)
  category?: ComplaintCategory;

  @ApiPropertyOptional({ description: 'What nobody has picked up yet.' })
  @IsOptional()
  @IsBoolean()
  unassignedOnly?: boolean;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class FeedbackQueryDto {
  @ApiPropertyOptional({ description: 'One provider’s ratings.' })
  @IsOptional()
  @IsUUID()
  doctorId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 5,
    description: 'At most this. Set it to 2 to read what went badly.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  maxRating?: number;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
