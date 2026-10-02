import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { UpdatePatientProfileDto } from './dto/patient-profile.dto';
import { PatientProfileService } from './patient-profile.service';

@ApiTags('patients')
@ApiBearerAuth()
@Controller({ version: '1' })
export class PatientsController {
  constructor(private readonly profiles: PatientProfileService) {}

  @Roles('patient')
  @Get('me/profile')
  @ApiOperation({
    summary: 'My profile',
    description:
      '`age` is derived from `dateOfBirth` on every read and is never stored. `isComplete` is false until FR-2.2 has both a name and a date of birth.',
  })
  getOwn(@CurrentActor() actor: AuthenticatedActor) {
    return this.profiles.getOwn(actor.id);
  }

  @Roles('patient')
  @Patch('me/profile')
  @ApiOperation({
    summary: 'Edit my profile',
    description:
      'Completing name and date of birth moves the account from `pending` to `active`. The mobile number is the sign-in identifier and cannot be changed here.',
  })
  update(@Body() dto: UpdatePatientProfileDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.profiles.update(actor.id, dto);
  }

  @Roles('doctor')
  @Get('patients/:patientId/card')
  @ApiOperation({
    summary: 'The appointment-card view of a patient (FR-9.2)',
    description:
      'Initials, age and gender - not a name. Refused unless a consultation ties this doctor to this patient (SRS 6.2), which M-11 answers through the `PATIENT_ASSIGNMENT` port.',
  })
  getCard(@Param('patientId') patientId: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.profiles.getCardForDoctor(actor.id, patientId);
  }
}
