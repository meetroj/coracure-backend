import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { FollowupPathway } from '@prisma/client';
import * as z from 'zod';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor, assertPermission } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { DEFAULT_PATHWAYS } from './default-pathways';
import { FollowupError } from './followup.errors';
import {
  CheckinQuestion,
  RedFlagRule,
  parseQuestions,
  parseRules,
  questionsSchema,
  redFlagRulesSchema,
} from './pathway';

/** A pathway version, as the admin panel shows it. */
export interface PathwayRecord {
  id: string;
  code: string;
  name: string;
  version: number;
  durationDays: number;
  questions: CheckinQuestion[];
  redFlagRules: RedFlagRule[];
  isCurrent: boolean;
  createdAt: Date;
}

export interface PathwayInput {
  name: string;
  durationDays: number;
  questions: unknown;
  redFlagRules: unknown;
}

/**
 * M-16's question sets and red-flag rules. Owns `followup_pathways`.
 *
 * *** ADMIN-AUTHORED, AND VERSIONED WHOLE (FR-13.7). ***
 *
 * The wording and the rules are clinical content the client's clinician signs
 * off, so they are rows an admin edits rather than code in an app release: a
 * question that reads badly, or a rule that fires too often, has to be fixable
 * this afternoon for patients who are already mid-follow-up.
 *
 * *** EDITING NEVER MUTATES. *** A save writes a NEW version and makes it
 * current; the old one stays exactly as it was. Anything else would change the
 * questions under a patient part-way through their seven days, which would make
 * yesterday's answer and today's incomparable, and would leave an alert raised
 * last week pointing at a rule that no longer says what it said.
 */
@Injectable()
export class PathwaysService {
  private readonly logger = new Logger(PathwaysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every version of every pathway, newest first. For the admin panel. */
  async listAll(actor: AuthenticatedActor): Promise<PathwayRecord[]> {
    assertPermission(actor, 'clinical_governance', 'content', 'operations');
    const rows = await this.prisma.followupPathway.findMany({
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    });
    return rows.map(shape);
  }

  /** The five a doctor picks from: one current version per pathway. */
  async listCurrent(): Promise<PathwayRecord[]> {
    const rows = await this.prisma.followupPathway.findMany({
      where: { isCurrent: true },
      orderBy: { code: 'asc' },
    });
    return rows.map(shape);
  }

  async requireCurrent(code: string): Promise<FollowupPathway> {
    const found = await this.prisma.followupPathway.findFirst({
      where: { code, isCurrent: true },
    });
    if (!found) {
      throw new AppException(
        FollowupError.PATHWAY_NOT_FOUND,
        'That follow-up pathway is not available.',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }

  /**
   * Publish a new version of a pathway.
   *
   * The version number is taken from what is already stored rather than from
   * the caller: two admins saving at once must not both write version 4, and
   * the unique index on (code, version) is what makes that impossible rather
   * than unlikely.
   */
  async publish(
    code: string,
    input: PathwayInput,
    actor: AuthenticatedActor,
  ): Promise<PathwayRecord> {
    // Clinical content, so clinical governance or the content editors.
    assertPermission(actor, 'clinical_governance', 'content');

    const questions = questionsSchema.safeParse(input.questions);
    if (!questions.success) throw invalid('questions', z.prettifyError(questions.error));
    const rules = redFlagRulesSchema.safeParse(input.redFlagRules);
    if (!rules.success) throw invalid('redFlagRules', z.prettifyError(rules.error));

    // *** EVERY RULE MUST POINT AT A QUESTION THAT EXISTS. ***
    // A rule naming a question the set does not contain can never fire, which
    // is the worst possible failure here: a safety rule that looks present in
    // the panel and is silently dead for every patient on the pathway.
    const questionIds = new Set(questions.data.map((question) => question.id));
    const dangling = rules.data.filter((rule) => !questionIds.has(rule.questionId));
    if (dangling.length > 0) {
      throw invalid(
        'redFlagRules',
        `These rules name questions that are not in the set, so they could never fire: ${dangling
          .map((rule) => rule.questionId)
          .join(', ')}`,
      );
    }

    const latest = await this.prisma.followupPathway.findFirst({
      where: { code },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    // The new version becomes current and the old one stops being it, together:
    // a partial unique index refuses two current versions of one pathway, so
    // these cannot be two separate writes.
    const [, created] = await this.prisma.$transaction([
      this.prisma.followupPathway.updateMany({
        where: { code, isCurrent: true },
        data: { isCurrent: false },
      }),
      this.prisma.followupPathway.create({
        data: {
          code,
          name: input.name.trim(),
          version,
          durationDays: input.durationDays,
          questions: questions.data,
          redFlagRules: rules.data,
          isCurrent: true,
        },
      }),
    ]);

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'followup_pathway',
      entityId: created.id,
      // When a version went live is this entry, which is why the row carries no
      // `published_at`.
      metadata: {
        code,
        version,
        questionCount: questions.data.length,
        ruleCount: rules.data.length,
      },
    });
    return shape(created);
  }

  /**
   * Installs FR-13.1's five on first boot, and never again.
   *
   * Seeded rather than hardcoded, and PLACEHOLDER wording: the question text
   * and the red-flag thresholds are clinical content the client's clinician
   * signs off under SRS section 8, exactly as the legal copy is. From the first
   * admin edit these rows are the truth and this file is only what a brand new
   * database started with.
   */
  async seedDefaults(): Promise<void> {
    for (const definition of DEFAULT_PATHWAYS) {
      const existing = await this.prisma.followupPathway.findFirst({
        where: { code: definition.code },
        select: { id: true },
      });
      // Never overwrite: an admin's edit outranks the shipped default for ever.
      if (existing) continue;

      await this.prisma.followupPathway.create({
        data: {
          code: definition.code,
          name: definition.name,
          version: 1,
          durationDays: definition.durationDays,
          questions: definition.questions,
          redFlagRules: definition.redFlagRules,
          isCurrent: true,
        },
      });
      this.logger.log({ code: definition.code }, 'Seeded placeholder follow-up pathway');
    }
  }
}

function shape(row: FollowupPathway): PathwayRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    version: row.version,
    durationDays: row.durationDays,
    questions: parseQuestions(row.questions),
    redFlagRules: parseRules(row.redFlagRules),
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
  };
}

function invalid(field: string, detail: string): AppException {
  return new AppException(
    FollowupError.PATHWAY_INVALID,
    'This pathway cannot be published as written.',
    HttpStatus.BAD_REQUEST,
    { field, detail },
  );
}
