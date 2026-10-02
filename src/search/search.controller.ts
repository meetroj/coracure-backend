import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AppConfigService } from '../app-config/app-config.service';
import { AuthenticatedActor, CurrentActor, Roles, assertPermission } from '../common/auth';
import {
  SearchQueryDto,
  UpdateCrisisKeywordsDto,
  UpdateDisclaimerDto,
  UpdateEmergencyGuidanceDto,
  UpdatePopularSearchesDto,
  UpdateSynonymsDto,
} from './dto/search.dto';
import {
  CRISIS_KEYWORDS_KEY,
  DISCLAIMER_KEY,
  EMERGENCY_GUIDANCE_KEY,
  POPULAR_SEARCHES_KEY,
  SYNONYMS_KEY,
} from './search.config';
import { SearchService } from './search.service';

/**
 * Symptom search and the concern guide (FR-4.5).
 *
 * Reachable two ways per FR-5.9 - the home search box and the assistant entry
 * that opens over the current screen - and both are the same endpoint, so both
 * get the same mapping and the same crisis guardrail. There is no second, looser
 * path into this engine.
 *
 * Admins may call it too. FR-5.7 lets them change the mapping, the synonyms and
 * the crisis list with no release, and a change nobody can try out before it is
 * live is one nobody will make carefully.
 */
@ApiTags('search')
@ApiBearerAuth()
@Roles('patient', 'admin')
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Describe a problem in plain words (FR-5.1)',
    description:
      'A POST, not a GET, so the query stays out of access logs and browser history — FR-5.11 keeps searches off the server. Returns SERVICES with the fee and the soonest the pool can cover them, never a list of providers. If `crisis` is true, `results` is empty and `guidance` is what the screen must show instead (FR-5.6).',
  })
  query(@Body() dto: SearchQueryDto) {
    return this.search.search(dto.query);
  }

  @Get('guide')
  @ApiOperation({
    summary: 'The concern guide, for a patient who is unsure (FR-5.5)',
    description: 'Every service with its concerns. A route, never a gate before booking.',
  })
  guide() {
    return this.search.guide();
  }

  @Get('suggestions')
  @ApiOperation({
    summary: 'What to show before anything is typed (FR-5.11)',
    description:
      'The admin-edited popular list. RECENT searches are absent on purpose: they live on the device, and an endpoint returning them would mean the server had kept them.',
  })
  suggestions() {
    return this.search.suggestions();
  }
}

/**
 * FR-5.7: the mapping, synonyms and crisis list are editable with no release.
 *
 * The symptom-to-concern phrases themselves are NOT here - they are columns on
 * `concerns`, edited through M-06's `/admin/concerns`. What this controller owns
 * is the query side, and the two pieces of safety-critical copy.
 *
 * `clinical_governance` is required for the crisis list and the emergency
 * guidance and cannot be substituted by `content`. SRS section 8 puts crisis
 * wording among the content a qualified clinician must approve, and the
 * permission model should say the same thing the compliance section does.
 */
@ApiTags('admin/search')
@ApiBearerAuth()
@Roles('admin')
@Controller({ path: 'admin/search', version: '1' })
export class AdminSearchController {
  constructor(
    private readonly search: SearchService,
    private readonly config: AppConfigService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary: 'Everything M-09 reads from configuration',
    description: 'The concern phrases themselves are M-06’s, under /admin/concerns.',
  })
  async current(@CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    const [crisisKeywords, synonyms, popular, guidance, disclaimer] = await Promise.all([
      this.search.crisisKeywords(),
      this.search.synonyms(),
      this.search.popularSearches(),
      this.search.emergencyGuidance(),
      this.search.disclaimer(),
    ]);
    return { crisisKeywords, synonyms, popular, emergencyGuidance: guidance, disclaimer };
  }

  @Patch('crisis-keywords')
  @ApiOperation({
    summary: 'Edit the crisis keyword list (FR-5.7)',
    description:
      'Clinically approved content (SRS 8). Matched as whole phrases on word boundaries, so `die` never fires on `diet`.',
  })
  async setCrisisKeywords(
    @Body() dto: UpdateCrisisKeywordsDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'clinical_governance');
    await this.config.set(CRISIS_KEYWORDS_KEY, dto.keywords, { type: actor.type, id: actor.id });
    return { keywords: await this.search.crisisKeywords() };
  }

  @Patch('emergency-guidance')
  @ApiOperation({
    summary: 'Edit what a patient in crisis is shown (FR-5.6)',
    description:
      'Every number here must be confirmed by the client before launch: a helpline that has changed number is worse than no helpline at all.',
  })
  async setGuidance(
    @Body() dto: UpdateEmergencyGuidanceDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'clinical_governance');
    // Rebuilt field by field rather than spread: the DTO instance carries
    // class-validator metadata, and only the values belong in the stored JSON.
    await this.config.set(
      EMERGENCY_GUIDANCE_KEY,
      {
        title: dto.title,
        message: dto.message,
        helplines: dto.helplines.map((helpline) => ({
          name: helpline.name,
          number: helpline.number,
          ...(helpline.available === undefined ? {} : { available: helpline.available }),
        })),
        ...(dto.footer === undefined ? {} : { footer: dto.footer }),
      },
      { type: actor.type, id: actor.id },
    );
    return this.search.emergencyGuidance();
  }

  @Patch('synonyms')
  @ApiOperation({
    summary: 'Edit the synonym table (FR-5.7)',
    description:
      'Read in both directions. This is the layer BEFORE the taxonomy, so a Hindi or informal word reaches the mapping as the word the mapping was written in.',
  })
  async setSynonyms(@Body() dto: UpdateSynonymsDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    await this.config.set(SYNONYMS_KEY, dto.synonyms, { type: actor.type, id: actor.id });
    return { synonyms: await this.search.synonyms() };
  }

  @Patch('popular-searches')
  @ApiOperation({ summary: 'Edit the popular searches list (FR-5.11)' })
  async setPopular(
    @Body() dto: UpdatePopularSearchesDto,
    @CurrentActor() actor: AuthenticatedActor,
  ) {
    assertPermission(actor, 'content');
    await this.config.set(POPULAR_SEARCHES_KEY, dto.popular, { type: actor.type, id: actor.id });
    return { popular: await this.search.popularSearches() };
  }

  @Patch('disclaimer')
  @ApiOperation({
    summary: 'Edit the wording FR-5.8 requires',
    description:
      'Returned with every search response rather than left to the app, so the statement cannot go missing by a client forgetting to render it.',
  })
  async setDisclaimer(@Body() dto: UpdateDisclaimerDto, @CurrentActor() actor: AuthenticatedActor) {
    assertPermission(actor, 'content', 'clinical_governance');
    await this.config.set(DISCLAIMER_KEY, dto.disclaimer, { type: actor.type, id: actor.id });
    return { disclaimer: await this.search.disclaimer() };
  }
}
