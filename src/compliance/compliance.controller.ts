import { Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import { ComplianceService } from './compliance.service';
import { AuditQueryDto } from './dto/compliance.dto';
import { SubjectAccessService } from './subject-access.service';

/**
 * SRS 5.2, 5.3, 6.1 and 6.7. Proving who saw and changed what, and honouring
 * data requests.
 *
 * *** SEARCHING THE LOG IS ITSELF LOGGED. *** Reading who saw what is a
 * privileged act, and a trail that does not record its own readers cannot
 * answer the question it exists for.
 *
 * *** WHAT AN ADMIN MAY READ DEPENDS ON THEIR LEVEL. *** `super_admin` reads
 * everything; everyone else reads the entity types their own work covers. That
 * is the same least-privilege rule the rest of the panel runs on, applied to
 * the one table that describes all of it.
 */
@ApiTags('admin/compliance')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/compliance', version: '1' })
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly subjectAccess: SubjectAccessService,
  ) {}

  @Get('audit')
  @ApiOperation({
    summary: 'Search the audit trail (SRS 6.7)',
    description:
      'By actor, by module, by target and by date. What you can see is narrowed to the entity types your admin level covers — a content editor has no business reading the trail of a clinical record.',
  })
  search(@Query() query: AuditQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.compliance.search(actor, {
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('audit/export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'The same search, as a file' })
  export(@Query() query: AuditQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.compliance.exportCsv(actor, {
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('audit/consultation/:consultationId')
  @ApiOperation({
    summary: 'Everything that ever touched one consultation, in order',
    description:
      'M-21’s completion criterion as a query: a clinical record read, a refund and a configuration change each leaving a complete entry with actor, target and time. This is the view a complaint or a subject access request is answered from.',
  })
  trail(
    @Param('consultationId') consultationId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.compliance.trailFor(consultationId, actor);
  }

  @Get('retention')
  @ApiOperation({
    summary: 'How long audit entries are kept (SRS 5.3)',
    description: 'The client’s to set. Editable in `app_config`.',
  })
  async retention() {
    return { retentionDays: await this.compliance.retentionDays() };
  }

  @Post('retention/apply')
  @ApiOperation({
    summary: 'Retire entries past the retention period',
    description:
      'Super admin only, and BY AGE ONLY — there is no filter on this call. A retention sweep that could be aimed at an actor or a date range would be a way to erase one inconvenient entry, which is exactly what an audit log exists to prevent. The sweep writes its own entry, so the trail records that a slice of the trail was retired.',
  })
  applyRetention(@CurrentActor() actor: AuthenticatedActor) {
    return this.compliance.applyRetention(actor);
  }

  @Post('deletion-requests/:requestId/execute')
  @ApiOperation({
    summary: 'Execute an approved erasure (SRS 6.4)',
    description:
      'M-03 takes the request and an admin approves it; this runs it. The outcome — what was deleted per table, what was lawfully retained and on what ground — is written back onto the request row, and a failure writes its reason into the same record. The patient id survives in the audit trail on purpose: erasing the evidence that an erasure happened would make the obligation unprovable.',
  })
  executeDeletion(
    @Param('requestId') requestId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.compliance.executeDeletion(requestId, actor);
  }

  @Get('patients/:patientId/data-export')
  @ApiOperation({
    summary: 'Everything held about one person (SRS 6.4)',
    description:
      'The counterpart to erasure — a data-rights regime that can delete but cannot show is half a regime. Super admin only: this is the single widest read of one person’s data in the platform, so the level that can perform it is the level that can also authorise an erasure. What is deliberately left out is named in the document itself, under `notIncluded`.',
  })
  exportPatientData(
    @Param('patientId') patientId: string,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    return this.subjectAccess.forPatient(patientId, actor);
  }
}

/**
 * The patient's own copy of their data.
 *
 * Theirs to ask for directly, which is the ordinary case: a data-rights request
 * that has to go through a support queue is one most people never make.
 */
@ApiTags('support')
@ApiBearerAuth()
@Roles('patient')
@Controller({ path: 'me', version: '1' })
export class PatientDataRightsController {
  constructor(private readonly subjectAccess: SubjectAccessService) {}

  @Get('data-export')
  @ApiOperation({
    summary: 'Everything we hold about you',
    description:
      'Your profile, consultations, clinical records, payments, follow-up answers, complaints and messages. Files are listed by name and date — the files themselves download from your own account through a link that expires. `notIncluded` says what is not here and why.',
  })
  mine(@CurrentActor() actor: AuthenticatedActor) {
    return this.subjectAccess.forSelf(actor);
  }
}
