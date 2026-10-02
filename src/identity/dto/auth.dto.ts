import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** E.164, which is how every mobile number is stored (`varchar(16)`). */
const E164 = /^\+[1-9]\d{7,14}$/;

export class RequestOtpDto {
  @ApiProperty({ example: '+919876543210', description: 'E.164, including the country code' })
  @Matches(E164, { message: 'mobileNumber must be in E.164 form, for example +919876543210' })
  @MaxLength(16)
  mobileNumber!: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @ApiProperty({ description: 'Returned by the OTP request call' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  challengeId!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 10)
  code!: string;

  @ApiPropertyOptional({ description: 'FCM token for this install; replaces the one on file' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  pushToken?: string;

  @ApiPropertyOptional({ description: 'Stable device identifier (FR-1.8)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceId?: string;
}

export class AdminSignInDto {
  @ApiProperty({ example: 'admin@coracure.in' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

export class AdminTwoFactorDto {
  @ApiProperty({ description: 'Returned by the sign-in call when two-factor is on' })
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(4, 10)
  code!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/** The permission levels an admin account may hold (`admin_permission_level`). */
export const ADMIN_PERMISSION_LEVELS = [
  'super_admin',
  'operations',
  'clinical_governance',
  'care_coordinator',
  'finance',
  'content',
] as const;

export class CreateAdminDto {
  @ApiProperty({ example: 'ops@coracure.in' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ minLength: 12, description: 'Stored only as an argon2id hash' })
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  fullName!: string;

  @ApiProperty({ enum: ADMIN_PERMISSION_LEVELS })
  @IsEnum(ADMIN_PERMISSION_LEVELS)
  permissionLevel!: (typeof ADMIN_PERMISSION_LEVELS)[number];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is2faEnabled?: boolean;
}
