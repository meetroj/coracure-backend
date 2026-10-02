import { Module, OnModuleInit } from '@nestjs/common';

import { AppConfigService } from '../app-config/app-config.service';
import { env } from '../config/env.validation';
import { OpenAiQueryAssist } from './openai-assist';
import { NoQueryAssist, QUERY_ASSIST } from './query-assist';
import { AdminSearchController, SearchController } from './search.controller';
import {
  CRISIS_KEYWORDS,
  CRISIS_KEYWORDS_KEY,
  DISCLAIMER,
  DISCLAIMER_KEY,
  EMERGENCY_GUIDANCE,
  EMERGENCY_GUIDANCE_KEY,
  POPULAR_SEARCHES,
  POPULAR_SEARCHES_KEY,
  SYNONYMS,
  SYNONYMS_KEY,
  emergencyGuidanceSchema,
  popularSearchesSchema,
} from './search.config';
import { SearchService } from './search.service';

/**
 * M-09 Search and Concern Mapping. Owns NO table, and that is the design.
 *
 * The symptom mapping is `concerns.match_phrases`, owned by M-06 - a second copy
 * here could disagree with the taxonomy the client had approved. Recent searches
 * are on the device (FR-5.11). Everything else this module needs is an
 * `app_config` value it owns and an admin edits with no release.
 *
 * NOT global, unlike M-05, M-07 and M-08: nothing calls a search. It reads the
 * catalogue (M-06) and asks the scheduler when a pool can next cover a service
 * (M-07), and produces the input to assignment. M-05 is deliberately not a
 * dependency - this module names a service and never reads the provider roster.
 */
@Module({
  controllers: [SearchController, AdminSearchController],
  providers: [
    SearchService,
    {
      provide: QUERY_ASSIST,
      // No production refinement on this one. The deterministic mapping is a
      // complete search on its own, so `none` is a product choice rather than a
      // misconfiguration - see `env.validation`.
      useClass: env().SEARCH_AI_PROVIDER === 'openai' ? OpenAiQueryAssist : NoQueryAssist,
    },
  ],
  exports: [SearchService],
})
export class SearchModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Everything FR-5.7 and FR-5.11 make admin-editable becomes data on first
   * boot. `seed` never overwrites, so a redeploy cannot quietly restore the
   * shipped crisis list over one a clinician has approved.
   */
  async onModuleInit(): Promise<void> {
    await this.config.seed([
      {
        key: CRISIS_KEYWORDS_KEY,
        value: CRISIS_KEYWORDS,
        description:
          'Self-harm and crisis phrases that interrupt booking and show emergency guidance instead of results (FR-5.6). CLINICALLY APPROVED CONTENT - SRS section 8. What ships is a starting point for the client to replace.',
        // Has its own screen, which validates more than a shape check could.
        managedBy: 'crisis keywords',
      },
      {
        key: EMERGENCY_GUIDANCE_KEY,
        value: EMERGENCY_GUIDANCE,
        description:
          'What a patient sees instead of results when crisis language is detected (FR-5.6). THE CLIENT MUST CONFIRM EVERY HELPLINE NUMBER BEFORE LAUNCH.',
        schema: emergencyGuidanceSchema,
        editableBy: ['content', 'clinical_governance'],
      },
      {
        key: SYNONYMS_KEY,
        value: SYNONYMS,
        description:
          'Query-side synonyms, read in both directions (FR-5.7). The layer before the taxonomy, so Hindi and informal wording reaches the mapping. NOT the mapping itself - that is `concerns.match_phrases`, owned by M-06.',
        // Has its own screen, which validates more than a shape check could.
        managedBy: 'search synonyms',
      },
      {
        key: POPULAR_SEARCHES_KEY,
        value: POPULAR_SEARCHES,
        description: 'What the search box offers before anything is typed (FR-5.11).',
        schema: popularSearchesSchema,
        editableBy: ['content'],
      },
      {
        key: DISCLAIMER_KEY,
        value: DISCLAIMER,
        description:
          'FR-5.8: states plainly that the module recommends whom to consult and does not screen, diagnose or decide treatment. Returned with every search response.',
        // Has its own screen, which validates more than a shape check could.
        managedBy: 'search disclaimer',
      },
    ]);
  }
}
