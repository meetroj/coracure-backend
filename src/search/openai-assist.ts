import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { env } from '../config/env.validation';
import { AssistableConcern, QueryAssist, withTimeout } from './query-assist';

/**
 * The optional assistant, switched on by `SEARCH_AI_PROVIDER=openai`.
 *
 * It runs only when the approved mapping matched nothing, and its answer is
 * filtered back down to codes that were in the list it was given - so a model
 * that hallucinates a category produces nothing rather than a new one.
 *
 * What is sent: the patient's own words and the concern names. Nothing else -
 * no name, no account id, no history. The query is not stored here either
 * (FR-5.11), and this is the only point in the module where it leaves the
 * process at all, which is why the trade is worth stating plainly in the README
 * rather than leaving for someone to discover.
 */
@Injectable()
export class OpenAiQueryAssist implements QueryAssist {
  private readonly logger = new Logger(OpenAiQueryAssist.name);
  private client?: OpenAI;

  async suggest(query: string, catalogue: AssistableConcern[]): Promise<string[]> {
    if (catalogue.length === 0) return [];

    const allowed = new Set(catalogue.map((concern) => concern.code));
    const raw = await withTimeout(
      this.ask(query, catalogue),
      env().SEARCH_AI_TIMEOUT_MS,
      this.logger,
    );
    if (!raw) return [];

    // *** THE CAGE *** Anything not already in the taxonomy is dropped. The
    // model is choosing from a menu, not writing one.
    return raw.filter((code) => allowed.has(code)).slice(0, MAX_SUGGESTIONS);
  }

  private async ask(query: string, catalogue: AssistableConcern[]): Promise<string[]> {
    const client = (this.client ??= new OpenAI({ apiKey: env().OPENAI_API_KEY }));
    const menu = catalogue.map((concern) => `${concern.code}: ${concern.name}`).join('\n');

    const response = await client.chat.completions.create({
      model: env().SEARCH_AI_MODEL,
      // Navigation, not judgement. The wording of this prompt is part of the
      // SRS section 8 commitment and should be reviewed with the mapping.
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You route a health app search box. You are NOT a clinician.',
            'Given the user text, choose which of the listed concerns it is most likely about.',
            'Choose ONLY from the codes given. Never invent a code. Never diagnose, never assess severity, never give advice.',
            'If nothing fits, return an empty list.',
            'Reply as JSON: {"codes": ["code1", "code2"]}, best first, at most 3.',
            '',
            'Concerns:',
            menu,
          ].join('\n'),
        },
        { role: 'user', content: query.slice(0, MAX_QUERY_CHARS) },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return [];
    const parsed = JSON.parse(content) as { codes?: unknown };
    return Array.isArray(parsed.codes)
      ? parsed.codes.filter((code): code is string => typeof code === 'string')
      : [];
  }
}

const MAX_SUGGESTIONS = 3;
/** A query longer than this is not a symptom description; it is a paste. */
const MAX_QUERY_CHARS = 400;
