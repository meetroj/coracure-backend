import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import { AllocationPolicyService } from './allocation-policy.service';
import { ConcernsService } from './concerns.service';
import {
  CreateConcernDto,
  CreateRegionDto,
  CreateSpecialtyDto,
  UpdateAllocationPolicyDto,
  UpdateConcernDto,
  UpdateRegionDto,
  UpdateSpecialtyDto,
} from './dto/catalogue.dto';
import { RegionsService } from './regions.service';
import { SpecialtiesService } from './specialties.service';
 
/**
 * What a patient and a provider read from the catalogue.
 *
 * `GET /services` is what replaced M-05's doctor directory. The patient picks a
 * SERVICE - and the price and the prescribing right are properties of that
 * service, because the patient does not choose who provides it (SRS 4.1, 4.2).
 */
@ApiTags('catalogue')
@ApiBearerAuth()
@Controller({ version: '1' })
export class CatalogueController {
  constructor(
    private readonly specialties: SpecialtiesService,
    private readonly concerns: ConcernsService,
    private readonly regions: RegionsService,
  ) {}

  @Roles('patient', 'doctor', 'admin')
  @Get('services')
  @ApiOperation({
    summary: 'The services a patient can book (FR-4.1)',
    description:
      'The only provider-facing choice a patient makes. `consultationFeeInr` is what THEY pay, quoted before any provider is assigned.',
  })
  listServices() {
    return this.specialties.listServices();
  }

  @Roles('patient', 'doctor', 'admin')
  @Get('concerns')
  @ApiOperation({
    summary: 'The concern taxonomy (FR-5.2)',
    description:
      'What symptom search maps a query onto. A concern names a service, never a person.',
  })
  listConcerns(@Query('specialtyId') specialtyId?: string) {
    return this.concerns.list(specialtyId);
  }

  @Roles('patient', 'doctor', 'admin')
  @Get('regions')
  @ApiOperation({
    summary: 'The regions a patient can pick in their profile (FR-20.10)',
    description: 'States or provinces. A patient region is a preference assignment matches on.',
  })
  listRegions() {
    return this.regions.listActive();
  }
}

/**
 * FR-18.2 and FR-18.9. `content` runs the catalogue - specialties, concerns and
 * regions are configuration and copy. The allocation policy is `operations`,
 * because it decides how work is distributed across the provider roster.
 */
@ApiTags('admin/catalogue')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminCatalogueController {
  constructor(
    private readonly specialties: SpecialtiesService,
    private readonly concerns: ConcernsService,
    private readonly regions: RegionsService,
    private readonly policy: AllocationPolicyService,
  ) {}

  // -- Specialties ----------------------------------------------------------

  @Get('specialties')
  @ApiOperation({ summary: 'Every specialty, active or not' })
  listSpecialties(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'operations', 'clinical_governance');
    return this.specialties.listAll();
  }

  @Get('specialties/:specialtyId')
  @ApiOperation({ summary: 'One specialty, with its forms and credential list' })
  getSpecialty(@Param('specialtyId') id: string, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'operations', 'clinical_governance');
    return this.specialties.get(id);
  }

  @Post('specialties')
  @ApiOperation({
    summary: 'Add a specialty (FR-19.1)',
    description:
      'This is how a new service goes live: no code change, no app release. `providerType` decides which registration form its providers are created on and whether it may prescribe.',
  })
  createSpecialty(@Body() dto: CreateSpecialtyDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.specialties.create(dto, actor);
  }

  @Patch('specialties/:specialtyId')
  @ApiOperation({
    summary: 'Edit a specialty',
    description:
      'A fee change applies to the next booking. Invoices already issued are frozen on the payment row, so a price rise never rewrites a paid bill.',
  })
  updateSpecialty(
    @Param('specialtyId') id: string,
    @Body() dto: UpdateSpecialtyDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.specialties.update(id, dto, actor);
  }

  // -- Concerns -------------------------------------------------------------

  @Get('concerns')
  @ApiOperation({ summary: 'Every concern, including disabled ones' })
  listConcerns(
    @Query('specialtyId') specialtyId: string | undefined,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.concerns.list(specialtyId, true);
  }

  @Post('concerns')
  @ApiOperation({ summary: 'Add a concern with its match phrases (FR-5.7)' })
  createConcern(@Body() dto: CreateConcernDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.concerns.create(dto, actor);
  }

  @Patch('concerns/:concernId')
  @ApiOperation({ summary: 'Edit a concern, its phrases or its weight' })
  updateConcern(
    @Param('concernId') id: string,
    @Body() dto: UpdateConcernDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'clinical_governance');
    return this.concerns.update(id, dto, actor);
  }

  // -- Regions --------------------------------------------------------------

  @Get('regions')
  @ApiOperation({ summary: 'Every region, active or not' })
  listRegions(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'operations');
    return this.regions.listAll();
  }

  @Post('regions')
  @ApiOperation({
    summary: 'Add a region (FR-19.8)',
    description: 'A state or province. Providers are put into it from the M-05 pool endpoints.',
  })
  createRegion(@Body() dto: CreateRegionDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'operations');
    return this.regions.create(dto, actor);
  }

  @Patch('regions/:regionId')
  @ApiOperation({
    summary: 'Rename or disable a region',
    description:
      'Disabling is refused while providers still serve it - it would silently shrink every assignment that matches on it.',
  })
  updateRegion(
    @Param('regionId') id: string,
    @Body() dto: UpdateRegionDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content', 'operations');
    return this.regions.update(id, dto, actor);
  }

  // -- Allocation policy ----------------------------------------------------

  @Get('allocation-policy')
  @ApiOperation({
    summary: 'How providers are allocated (SRS 4.20)',
    description: 'Note what is absent: nothing here can relax the language requirement.',
  })
  getPolicy(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations', 'clinical_governance');
    return this.policy.current();
  }

  @Patch('allocation-policy')
  @ApiOperation({
    summary: 'Change the allocation policy',
    description: 'Before and after are written to the audit log, which is the change history.',
  })
  updatePolicy(@Body() dto: UpdateAllocationPolicyDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'operations');
    return this.policy.update(dto, actor);
  }
}
