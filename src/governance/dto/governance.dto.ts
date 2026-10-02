import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class DashboardQueryDto {
  @ApiPropertyOptional({ description: 'Omit for all time.', example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class QueueQueryDto {
  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AllocationQueryDto extends QueueQueryDto {
  @ApiPropertyOptional({ description: 'Narrow to one consultation.' })
  @IsOptional()
  @IsUUID()
  consultationId?: string;
}

export class ExportKindDto {
  @ApiProperty({ enum: ['consultations', 'complaints', 'feedback', 'safety-alerts'] })
  @IsIn(['consultations', 'complaints', 'feedback', 'safety-alerts'])
  kind!: 'consultations' | 'complaints' | 'feedback' | 'safety-alerts';
}
