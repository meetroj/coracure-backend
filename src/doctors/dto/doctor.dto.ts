import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** E.164, which is how every mobile number is stored (`varchar(16)`). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Mirrors `doctor_document_type`. */
export const DOCTOR_DOCUMENT_TYPES = [
  'degree_certificate',
  'registration_certificate',
  'identity_proof',
  'address_proof',
  'experience_letter',
  'profile_photo',
  'signature',
  'other',
] as const;

/** Mirrors `doctor_verification_status`. */
export const DOCTOR_VERIFICATION_STATUSES = [
  'pending',
  'under_review',
  'verified',
  'rejected',
  'suspended',
] as const;

/** Mirrors `doctor_seniority`. */
export const DOCTOR_SENIORITY_LEVELS = ['standard', 'expert'] as const;

/**
 * Same set as the patient profile. FR-4.4 filters listings by language, so it
 * has to be a value the filter can match rather than free text.
 */
export const LANGUAGES = ['en', 'hi'] as const;

/** A credential file. Images and PDFs only - nothing executable is ever stored. */
export const CREDENTIAL_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const;

export class CreateDoctorDto {
  @ApiProperty({ example: '+919876543210', description: 'The sign-in identifier, E.164' })
  @Matches(E164, { message: 'mobileNumber must be in E.164 form, for example +919876543210' })
  @MaxLength(16)
  mobileNumber!: string;

  @ApiProperty({ example: 'Dr Meera Iyer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  fullName!: string;

  @ApiPropertyOptional({ description: 'One specialty. It decides prescribing eligibility.' })
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @ApiPropertyOptional({ example: 'MBBS, MD (Psychiatry)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  qualification?: string;

  @ApiPropertyOptional({
    example: 'KMC/12345',
    description: 'Medical council registration (FR-4.2)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  registrationNumber?: string;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(70)
  yearsOfExperience?: number;

  @ApiPropertyOptional({ enum: LANGUAGES, isArray: true, example: ['en', 'hi'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(LANGUAGES, { each: true })
  languages?: (typeof LANGUAGES)[number][];

  @ApiPropertyOptional({
    example: 800,
    description:
      'What this provider is PAID. NOT what the patient is charged - that is the specialty fee (FR-7.8).',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  payoutFeeInr?: number;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  consultationDurationMinutes?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bio?: string;
}

/** Everything an admin may edit (FR-18.1). Every field optional. */
export class UpdateDoctorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bio?: string;

  @ApiPropertyOptional({ enum: LANGUAGES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(LANGUAGES, { each: true })
  languages?: (typeof LANGUAGES)[number][];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  qualification?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  registrationNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(70)
  yearsOfExperience?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @ApiPropertyOptional({ description: 'What this provider is PAID, not the patient price' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  payoutFeeInr?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  consultationDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({ description: 'Whether instant requests may be routed to this doctor' })
  @IsOptional()
  @IsBoolean()
  allowInstantConsult?: boolean;

  @ApiPropertyOptional({
    description: 'Set once the admin has checked this provider’s payout details outside this system.',
  })
  @IsOptional()
  @IsBoolean()
  bankVerified?: boolean;
}

/**
 * What the doctor may change themselves. Qualification, registration number,
 * specialty and fee are absent on purpose - see `updateSelf`.
 */
export class UpdateOwnDoctorProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bio?: string;

  @ApiPropertyOptional({ enum: LANGUAGES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(LANGUAGES, { each: true })
  languages?: (typeof LANGUAGES)[number][];

  @ApiPropertyOptional({ description: 'FR-10.1: the doctor sets their own consultation length' })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  consultationDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;
}

export class SetSeniorityDto {
  @ApiProperty({ enum: DOCTOR_SENIORITY_LEVELS, description: 'FR-1.6' })
  @IsEnum(DOCTOR_SENIORITY_LEVELS)
  seniorityLevel!: (typeof DOCTOR_SENIORITY_LEVELS)[number];
}

export class SetListedDto {
  @ApiProperty({ description: 'Refused unless the doctor is already verified' })
  @IsBoolean()
  isListed!: boolean;
}

export class SuspendDoctorDto {
  @ApiProperty({ description: 'Recorded in the audit log; the doctor is signed out everywhere' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class RejectDoctorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class RequestCredentialUploadDto {
  @ApiProperty({ enum: DOCTOR_DOCUMENT_TYPES })
  @IsEnum(DOCTOR_DOCUMENT_TYPES)
  documentType!: (typeof DOCTOR_DOCUMENT_TYPES)[number];

  @ApiProperty({ example: 'mbbs-degree.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ enum: CREDENTIAL_CONTENT_TYPES })
  @IsIn(CREDENTIAL_CONTENT_TYPES)
  contentType!: (typeof CREDENTIAL_CONTENT_TYPES)[number];
}

export class ConfirmCredentialUploadDto {
  @ApiProperty({ enum: DOCTOR_DOCUMENT_TYPES })
  @IsEnum(DOCTOR_DOCUMENT_TYPES)
  documentType!: (typeof DOCTOR_DOCUMENT_TYPES)[number];

  @ApiProperty({ example: 'mbbs-degree.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'Exactly as returned by the upload-url call' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  storageKey!: string;
}

export class ReviewCredentialDto {
  @ApiProperty({ description: 'false rejects it, and then `rejectionReason` is required' })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: 'What the doctor has to fix. Required on a rejection.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  rejectionReason?: string;
}

export class SetDoctorRegionsDto {
  @ApiProperty({
    isArray: true,
    type: String,
    description: 'The complete set of regions this provider serves. Sent whole, not incrementally.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  regionIds!: string[];
}

/**
 * The ADMIN roster's filters. There is no patient-facing version: SRS 1.2
 * removed provider browsing, so there is nothing to filter or sort by fee.
 */
export class DoctorSearchQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  specialtyId?: string;

  @ApiPropertyOptional({ enum: LANGUAGES })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: (typeof LANGUAGES)[number];

  @ApiPropertyOptional({ description: 'Who serves this region' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ enum: DOCTOR_SENIORITY_LEVELS })
  @IsOptional()
  @IsEnum(DOCTOR_SENIORITY_LEVELS)
  seniorityLevel?: (typeof DOCTOR_SENIORITY_LEVELS)[number];

  @ApiPropertyOptional({ enum: ['experience_desc', 'name'] })
  @IsOptional()
  @IsIn(['experience_desc', 'name'])
  sort?: 'experience_desc' | 'name';

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** The admin roster, which unlike the directory sees every state. */
export class AdminDoctorQueryDto extends DoctorSearchQueryDto {
  @ApiPropertyOptional({ enum: DOCTOR_VERIFICATION_STATUSES })
  @IsOptional()
  @IsEnum(DOCTOR_VERIFICATION_STATUSES)
  verificationStatus?: (typeof DOCTOR_VERIFICATION_STATUSES)[number];

  @ApiPropertyOptional({ description: 'true or false; anything else is rejected' })
  @IsOptional()
  // `Type(() => Boolean)` is wrong on a query string: Boolean('false') is true,
  // so `?isListed=false` would filter for listed doctors.
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    obj.isListed === 'true' ? true : obj.isListed === 'false' ? false : obj.isListed,
  )
  @IsBoolean()
  isListed?: boolean;

  @ApiPropertyOptional({ description: 'Name, mobile number or registration number' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

/* ---------------------------- self-registration ---------------------------- */

export const DOCTOR_GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
export const GOVERNMENT_ID_TYPES = ['aadhaar', 'passport', 'driving_licence', 'voter_id', 'other'] as const;

export class RegistrationIdentityDto {
  @ApiProperty({ enum: GOVERNMENT_ID_TYPES })
  @IsIn(GOVERNMENT_ID_TYPES)
  idType!: (typeof GOVERNMENT_ID_TYPES)[number];

  @ApiPropertyOptional({ description: 'Only when idType is "other"' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  idTypeName?: string;

  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9 -]{4,32}$/, { message: 'idNumber must be 4-32 letters, digits, spaces or hyphens' })
  idNumber!: string;

  @ApiPropertyOptional({ description: 'ABHA ID or ABHA address. Optional.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  abhaId?: string;
}

export class RegistrationQualificationsDto {
  @ApiProperty({ example: 'MBBS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  basicQualification!: string;

  @ApiPropertyOptional({ example: 'MD Dermatology' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  pgSpecialisation?: string;

  @ApiPropertyOptional({ example: 'DM Endocrinology' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  superSpecialisation?: string;

  @ApiPropertyOptional({ example: 'Fellowship in Diabetology' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fellowship?: string;

  @ApiPropertyOptional({ description: 'A degree_certificate this doctor uploaded' })
  @IsOptional()
  @IsUUID()
  degreeCertificateId?: string;

  @ApiPropertyOptional({ description: 'A registration_certificate this doctor uploaded' })
  @IsOptional()
  @IsUUID()
  registrationCertificateId?: string;
}

export class RegistrationExperienceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  designation!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  institution!: string;

  @ApiProperty({ example: 5 })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(60)
  years!: number;

  @ApiPropertyOptional({ description: 'An experience_letter this doctor uploaded' })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

/** `PUT /me/doctor/registration` - a replace: lists sent become the whole of what is on file. */
export class SaveRegistrationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  fullName?: string;

  @ApiPropertyOptional({ example: '1988-03-12' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be YYYY-MM-DD' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: DOCTOR_GENDERS })
  @IsOptional()
  @IsIn(DOCTOR_GENDERS)
  gender?: (typeof DOCTOR_GENDERS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ description: 'Medical council or professional registration number, as the doctor states it. An admin verifies it.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  registrationNumber?: string;

  @ApiPropertyOptional({ type: RegistrationIdentityDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationIdentityDto)
  identity?: RegistrationIdentityDto;

  @ApiPropertyOptional({ type: RegistrationQualificationsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationQualificationsDto)
  qualifications?: RegistrationQualificationsDto;

  @ApiPropertyOptional({ type: [RegistrationExperienceDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RegistrationExperienceDto)
  experience?: RegistrationExperienceDto[];

  @ApiPropertyOptional({ description: 'The prescription signature this doctor uploaded' })
  @IsOptional()
  @IsUUID()
  signatureDocumentId?: string;
}
