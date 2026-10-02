import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { VerifiedDoctorsOnly } from '../doctors/doctor-access';
import { ClinicalTemplatesService } from './clinical-templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/clinical-templates.dto';

@ApiTags('clinical-templates')
@ApiBearerAuth()
@Roles('doctor')
@VerifiedDoctorsOnly()
@Controller({ path: 'doctor/clinical-templates', version: '1' })
export class ClinicalTemplatesController {
  constructor(private readonly templates: ClinicalTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'My templates' })
  list(@CurrentActor() actor: AuthenticatedActor) {
    return this.templates.list(actor);
  }

  @Post()
  @ApiOperation({ summary: 'Save a template (at most 50 per doctor)' })
  create(@Body() dto: CreateTemplateDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.templates.create(dto, actor);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit one of my templates' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.templates.update(id, dto, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one of my templates' })
  remove(@Param('id') id: string, @CurrentActor() actor: AuthenticatedActor) {
    return this.templates.remove(id, actor);
  }
}
