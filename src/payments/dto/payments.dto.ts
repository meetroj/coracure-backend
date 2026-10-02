import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RefundDto {
  @ApiPropertyOptional({
    description: 'Omit to refund the whole charge. Never more than was charged.',
    example: 708,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99999999)
  amount?: number;

  @ApiProperty({
    example: 'Provider could not attend; consultation cancelled.',
    description: 'Required. Shown to the patient with the refund status (FR-7.7).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}

export class MarkPayoutPaidDto {
  @ApiPropertyOptional({
    example: 'NEFT/2026/09/0041',
    description:
      'The bank reference. Kept in the audit entry rather than a column, because no screen prints it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class ExportKindDto {
  @ApiPropertyOptional({ enum: ['transactions', 'refunds'], default: 'transactions' })
  @IsOptional()
  @IsIn(['transactions', 'refunds'])
  kind?: 'transactions' | 'refunds';
}
