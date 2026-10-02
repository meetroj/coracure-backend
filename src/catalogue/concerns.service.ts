import { HttpStatus, Injectable } from '@nestjs/common';
import { Concern, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { CatalogueError } from './catalogue.errors';

export interface ConcernRecord {
  id: string;
  specialtyId: string;
  code: string;
  /** Also the plain-language reason FR-5.4 shows: "matched to: sleep, anxiety". */
  name: string;
  matchPhrases: string[];
  matchWeight: number;
  isActive: boolean;
}

export interface ConcernInput {
  specialtyId: string;
  code: string;
  name: string;
  matchPhrases?: string[];
  matchWeight?: number;
}

/**
 * The concern taxonomy a symptom search maps onto (FR-5.2). M-09 reads these
 * phrases; it owns no data of its own.
 *
 * Since version 1.2 a search resolves to a concern and its specialty, and that
 * pair is the input to assignment. It is no longer a way to reach a named
 * provider, because the patient does not choose one.
 */
@Injectable()
export class ConcernsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every active concern, or those of one specialty. Ordered by name (FR-5.2). */
  async list(specialtyId?: string, includeInactive = false): Promise<ConcernRecord[]> {
    const rows = await this.prisma.concern.findMany({
      where: {
        ...(specialtyId ? { specialtyId } : {}),
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(shape);
  }

  /**
   * The phrase book M-09 matches a query against. Ordered by weight so a
   * heavier concern wins a tie, which is the only ordering FR-5.4 asks for.
   */
  async matchTable(): Promise<ConcernRecord[]> {
    const rows = await this.prisma.concern.findMany({
      where: { isActive: true, specialty: { isActive: true } },
      orderBy: [{ matchWeight: 'desc' }, { name: 'asc' }],
    });
    return rows.map(shape);
  }

  async create(input: ConcernInput, actor: AuthenticatedActor): Promise<ConcernRecord> {
    let created: Concern;
    try {
      created = await this.prisma.concern.create({
        data: {
          specialtyId: input.specialtyId,
          code: input.code,
          name: input.name,
          ...(input.matchPhrases ? { matchPhrases: input.matchPhrases } : {}),
          ...(input.matchWeight !== undefined ? { matchWeight: input.matchWeight } : {}),
        },
      });
    } catch (error) {
      throw asConflict(error);
    }

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'concern',
      entityId: created.id,
      metadata: { code: input.code, specialtyId: input.specialtyId },
    });
    return shape(created);
  }

  async update(
    concernId: string,
    patch: Partial<Omit<ConcernInput, 'specialtyId'>> & { isActive?: boolean },
    actor: AuthenticatedActor,
  ): Promise<ConcernRecord> {
    await this.require(concernId);
    let updated: Concern;
    try {
      updated = await this.prisma.concern.update({ where: { id: concernId }, data: patch });
    } catch (error) {
      throw asConflict(error);
    }

    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'concern',
      entityId: concernId,
      metadata: { fields: Object.keys(patch) },
    });
    return shape(updated);
  }

  private async require(concernId: string): Promise<Concern> {
    const found = await this.prisma.concern.findUnique({ where: { id: concernId } });
    if (!found) {
      throw new AppException(
        CatalogueError.CONCERN_NOT_FOUND,
        'That concern does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }
}

/** `match_phrases` is jsonb; a CHECK keeps it an array, this keeps it strings. */
function phrasesOf(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function shape(concern: Concern): ConcernRecord {
  return {
    id: concern.id,
    specialtyId: concern.specialtyId,
    code: concern.code,
    name: concern.name,
    matchPhrases: phrasesOf(concern.matchPhrases),
    matchWeight: concern.matchWeight,
    isActive: concern.isActive,
  };
}

function asConflict(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new AppException(
        CatalogueError.CODE_ALREADY_EXISTS,
        'That specialty already has a concern with this code.',
        HttpStatus.CONFLICT,
      );
    }
    if (error.code === 'P2003') {
      return new AppException(
        CatalogueError.SPECIALTY_NOT_FOUND,
        'That specialty does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
  }
  return error;
}
