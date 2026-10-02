import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Mirrors the `legal_document_type` enum. */
export const LEGAL_DOCUMENT_TYPES = [
  'teleconsultation_consent',
  'privacy_policy',
  'terms_of_use',
  'refund_policy',
  'reconsult_policy',
  'doctor_agreement',
] as const;

export type LegalDocumentTypeValue = (typeof LEGAL_DOCUMENT_TYPES)[number];

/** The states an admin may move a deletion request into. */
export const REVIEW_DECISIONS = ['in_review', 'approved', 'rejected'] as const;

export class PublishLegalDocumentDto {
  @ApiProperty({ enum: LEGAL_DOCUMENT_TYPES })
  @IsEnum(LEGAL_DOCUMENT_TYPES)
  documentType!: LegalDocumentTypeValue;

  @ApiProperty({
    example: '2.0',
    description: 'Client-set. Publishing a new version is a new row; an accepted version is never edited.',
  })
  @IsString()
  @Matches(/^[\w.-]{1,20}$/, { message: 'version may contain letters, digits, dots, dashes and underscores' })
  version!: string;

  @ApiProperty({ example: 'Teleconsultation Consent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: 'The full legal copy, as supplied by the client' })
  @IsString()
  @IsNotEmpty()
  body!: string;
}

export class AcceptConsentDto {
  @ApiProperty({
    enum: LEGAL_DOCUMENT_TYPES,
    description:
      'The type only. The current version is resolved server-side, so a client can never accept a superseded one.',
  })
  @IsEnum(LEGAL_DOCUMENT_TYPES)
  documentType!: LegalDocumentTypeValue;
}

export class RequestDeletionDto {
  @ApiPropertyOptional({ description: 'Why, in the patient’s own words. Optional.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class ReviewDeletionDto {
  @ApiProperty({ enum: REVIEW_DECISIONS })
  @IsEnum(REVIEW_DECISIONS)
  status!: (typeof REVIEW_DECISIONS)[number];

  @ApiPropertyOptional({ description: 'Shown in the admin panel, not to the patient' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
