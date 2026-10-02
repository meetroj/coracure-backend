import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../app-config/app-config.service';
import { ConcernRecord, ConcernsService } from '../catalogue/concerns.service';
import { ServiceListing, SpecialtiesService } from '../catalogue/specialties.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { detectCrisis } from './crisis';
import { ConcernMatch, rankConcerns, reasonFor } from './matching';
import { QUERY_ASSIST, QueryAssist } from './query-assist';
import {
  CRISIS_KEYWORDS,
  CRISIS_KEYWORDS_KEY,
  DISCLAIMER,
  DISCLAIMER_KEY,
  EMERGENCY_GUIDANCE,
  EMERGENCY_GUIDANCE_KEY,
  EmergencyGuidance,
  POPULAR_SEARCHES,
  POPULAR_SEARCHES_KEY,
  SYNONYMS,
  SYNONYMS_KEY,
  crisisKeywordsSchema,
  disclaimerSchema,
  emergencyGuidanceSchema,
  popularSearchesSchema,
  synonymsSchema,
} from './search.config';

/** A result is a SERVICE, never a provider (FR-5.4, changed in SRS 1.2). */
export interface ServiceMatch extends ServiceListing {
  /** Which concerns of this service the query landed on. */
  concerns: { id: string; code: string; name: string }[];
  /** FR-5.4's plain-language reason: "matched to: sleep, anxiety". */
  reason: string;
  /**
   * The soonest the POOL can cover this service (FR-5.4), or null if nothing
   * inside the horizon. Never one provider's diary - the patient does not
   * choose a provider, so they are not shown one's calendar.
   */
  soonestAvailableAt: Date | null;
  /** Whether the approved mapping placed this, or the assistant suggested it. */
  matchedBy: 'mapping' | 'assistant';
}

export type SearchResponse =
  | {
      /** FR-5.8: returned every time, never left to the client to remember. */
      disclaimer: string;
      crisis: false;
      results: ServiceMatch[];
    }
  | {
      disclaimer: string;
      /** FR-5.6: guidance INSTEAD of results, and `results` is always empty. */
      crisis: true;
      guidance: EmergencyGuidance;
      results: never[];
    };

/** FR-5.5's "unsure whom to consult" flow. The same data, nothing typed. */
export interface GuideEntry extends ServiceListing {
  concerns: { id: string; code: string; name: string }[];
  soonestAvailableAt: Date | null;
}

/** More than this is a list nobody reads, and a pool query nobody needed. */
const MAX_RESULTS = 5;

/**
 * M-09 Search and Concern Mapping. Owns NO table.
 *
 * *** WHAT THIS PRODUCES IS A SERVICE, NOT A PERSON. *** Since SRS 1.2 the
 * patient picks a service and a time and never a provider, so a result carries
 * the fee for that service and the soonest the pool can cover it - not a named
 * provider with their own price and diary. The output is the input to
 * assignment (M-11), which is why M-05 is not a dependency of this module at
 * all: it never reads the roster.
 *
 * *** QUERIES ARE NOT LOGGED. *** FR-5.11 puts recent searches on the device
 * and keeps query logging out of this release, so nothing here writes an audit
 * entry, and the search route is a POST specifically so that what a patient
 * typed about their mental health does not land in an access log or a browser
 * history.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly config: AppConfigService,
    private readonly concerns: ConcernsService,
    private readonly specialties: SpecialtiesService,
    private readonly scheduling: SchedulingService,
    @Inject(QUERY_ASSIST) private readonly assist: QueryAssist,
  ) {}

  /**
   * The search (FR-5.1, FR-5.4, FR-5.6).
   *
   * The order of the first two steps is the safety property: crisis language is
   * checked before anything else runs, so no failure in matching, in the
   * catalogue or in the assistant can route around it.
   */
  async search(query: string, now = new Date()): Promise<SearchResponse> {
    const [disclaimer, keywords, synonyms] = await Promise.all([
      this.disclaimer(),
      this.crisisKeywords(),
      this.synonyms(),
    ]);

    if (detectCrisis(query, keywords, synonyms)) {
      return { disclaimer, crisis: true, guidance: await this.emergencyGuidance(), results: [] };
    }

    const catalogue = await this.concerns.matchTable();
    let matches = rankConcerns(query, catalogue, synonyms);
    let matchedBy: ServiceMatch['matchedBy'] = 'mapping';

    // The assistant runs ONLY on an empty result. Where the approved mapping
    // has an answer, that answer stands - a model does not get to reorder
    // clinically reviewed content.
    if (matches.length === 0) {
      matches = await this.assisted(query, catalogue);
      matchedBy = 'assistant';
    }

    return { disclaimer, crisis: false, results: await this.toServices(matches, matchedBy, now) };
  }

  /**
   * FR-5.5's concern guide: every service with the concerns under it, for a
   * patient who cannot put their problem into words. Never forced before
   * booking - it is a route, not a gate.
   */
  async guide(now = new Date()): Promise<{ disclaimer: string; services: GuideEntry[] }> {
    const [disclaimer, services, concerns] = await Promise.all([
      this.disclaimer(),
      this.specialties.listServices(),
      this.concerns.list(),
    ]);

    const entries = await Promise.all(
      services.map(async (service) => ({
        ...service,
        concerns: concerns.filter((concern) => concern.specialtyId === service.id).map(briefly),
        soonestAvailableAt: await this.scheduling.soonestForPool({ specialtyId: service.id }, now),
      })),
    );
    return { disclaimer, services: entries };
  }

  /**
   * What the search box shows before anything is typed (FR-5.11).
   *
   * Only the popular list, which an admin edits. RECENT searches are absent on
   * purpose: FR-5.11 keeps them on the device, and an endpoint returning them
   * would mean the server had been keeping them after all.
   */
  async suggestions(): Promise<{ disclaimer: string; popular: string[] }> {
    const [disclaimer, popular] = await Promise.all([this.disclaimer(), this.popularSearches()]);
    return { disclaimer, popular };
  }

  // -- Configuration, all admin-editable (FR-5.7) ---------------------------

  async crisisKeywords(): Promise<string[]> {
    return (await this.config.get(CRISIS_KEYWORDS_KEY, crisisKeywordsSchema)) ?? CRISIS_KEYWORDS;
  }

  async synonyms(): Promise<Record<string, string[]>> {
    return (await this.config.get(SYNONYMS_KEY, synonymsSchema)) ?? SYNONYMS;
  }

  async popularSearches(): Promise<string[]> {
    return (await this.config.get(POPULAR_SEARCHES_KEY, popularSearchesSchema)) ?? POPULAR_SEARCHES;
  }

  async emergencyGuidance(): Promise<EmergencyGuidance> {
    return (
      (await this.config.get(EMERGENCY_GUIDANCE_KEY, emergencyGuidanceSchema)) ?? EMERGENCY_GUIDANCE
    );
  }

  async disclaimer(): Promise<string> {
    return (await this.config.get(DISCLAIMER_KEY, disclaimerSchema)) ?? DISCLAIMER;
  }

  // -- Internals ------------------------------------------------------------

  /** Codes the assistant chose, resolved back to real taxonomy rows. */
  private async assisted(query: string, catalogue: ConcernRecord[]): Promise<ConcernMatch[]> {
    const codes = await this.assist.suggest(
      query,
      catalogue.map((concern) => ({ code: concern.code, name: concern.name })),
    );
    const byCode = new Map(catalogue.map((concern) => [concern.code, concern]));

    return codes.flatMap((code, index) => {
      const concern = byCode.get(code);
      if (!concern) return [];
      // Ranked by the order the assistant gave, and the reason names the
      // concern rather than a phrase - because no phrase matched.
      return [{ concern, score: codes.length - index, matchedPhrases: [concern.name] }];
    });
  }

  /**
   * Concerns become SERVICES. Several concerns of one specialty collapse into a
   * single result carrying all of them, because the patient is choosing a
   * service and offering the same one three times is three ways to say one
   * thing.
   */
  private async toServices(
    matches: ConcernMatch[],
    matchedBy: ServiceMatch['matchedBy'],
    now: Date,
  ): Promise<ServiceMatch[]> {
    if (matches.length === 0) return [];

    const grouped = new Map<string, { phrases: string[]; concerns: ConcernRecord[] }>();
    for (const match of matches) {
      const entry = grouped.get(match.concern.specialtyId) ?? { phrases: [], concerns: [] };
      entry.concerns.push(match.concern);
      for (const phrase of match.matchedPhrases) {
        if (!entry.phrases.includes(phrase)) entry.phrases.push(phrase);
      }
      grouped.set(match.concern.specialtyId, entry);
    }

    const services = await this.specialties.listServices();
    const byId = new Map(services.map((service) => [service.id, service]));

    // Ranked before the pool is asked anything: the availability lookup is the
    // expensive part, and it should run for what is being shown, not for
    // everything that matched.
    const top = [...grouped.entries()].filter(([id]) => byId.has(id)).slice(0, MAX_RESULTS);

    return Promise.all(
      top.map(async ([specialtyId, entry]) => ({
        ...byId.get(specialtyId)!,
        concerns: entry.concerns.map(briefly),
        reason: reasonFor(entry.phrases),
        soonestAvailableAt: await this.scheduling.soonestForPool({ specialtyId }, now),
        matchedBy,
      })),
    );
  }
}

function briefly(concern: ConcernRecord): { id: string; code: string; name: string } {
  return { id: concern.id, code: concern.code, name: concern.name };
}
