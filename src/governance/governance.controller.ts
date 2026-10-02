import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthenticatedActor, CurrentActor, Roles } from '../common/auth';
import {
  AllocationQueryDto,
  DashboardQueryDto,
  ExportKindDto,
  QueueQueryDto,
} from './dto/governance.dto';
import { GovernanceService } from './governance.service';

/**
 * FR-18.5 and FR-18.6. The admin's operational and clinical control room.
 *
 * *** EVERY FIGURE HERE IS COUNTED FROM THE OWNING MODULE'S ROWS. *** There is
 * no summary table and no nightly rollup, so a dashboard number cannot disagree
 * with its source — it is its source, counted when asked for. That is M-20's
 * completion criterion, and having no data of its own is how it is met.
 */
@ApiTags('admin/governance')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/governance', version: '1' })
export class GovernanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'The quality dashboard (FR-18.6)',
    description:
      'Consultations, safety alerts, follow-up, complaints and clarifications. Safety counts every OPEN alert regardless of the date window — an unclosed red flag from last month is still somebody’s problem today, and a queue that hides it behind a filter loses people.',
  })
  dashboard(@Query() query: DashboardQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.governance.dashboard(actor, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('pending-case-summaries')
  @ApiOperation({
    summary: 'Consultations held but not written up (FR-18.5)',
    description:
      'Oldest first — the question is what has been waiting longest, and a clinician’s memory of a consultation is the thing that decays. A DRAFT record still counts as pending: M-15’s freeze is what makes a summary a summary.',
  })
  pendingSummaries(@Query() query: QueueQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.governance.pendingCaseSummaries(actor, query.limit);
  }

  @Get('provider-quality')
  @ApiOperation({
    summary: 'Reliability metrics per provider (FR-18.6)',
    description:
      'Acceptance rate, no-show rate and case-summary completion. Read through M-05’s registry so the dashboard and the provider’s own profile show the same number. A rate is NULL rather than zero when its denominator is empty — a provider offered nothing has not failed to accept anything.',
  })
  providerQuality(@Query() query: QueueQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.governance.providerQuality(actor, query.limit);
  }

  @Get('allocation-decisions')
  @ApiOperation({
    summary: 'Who was assigned, and on what basis (FR-18.9)',
    description:
      'Read from the audit log, because that is the only place the answer exists: M-11 records WHO on the consultation row and WHY in the trail — why is a record of a decision rather than an attribute of the appointment.',
  })
  allocation(@Query() query: AllocationQueryDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.governance.allocationDecisions(actor, query);
  }

  @Get('export/:kind')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: 'Export a sheet (FR-18.4, FR-18.6)',
    description:
      'Flat rows, nothing aggregated: an export is evidence, and one that has already done the arithmetic cannot be checked against anything. Complaint bodies and message threads are deliberately excluded — those are the patient’s own words about a named clinician, and an export is a file that gets emailed around.',
  })
  export(@Param() params: ExportKindDto, @CurrentActor() actor: AuthenticatedActor) {
    return this.governance.exportCsv(params.kind, actor);
  }
}
