import { HttpStatus, Injectable } from '@nestjs/common';
import { Region } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedActor } from '../common/auth';
import { AppException } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { CatalogueError } from './catalogue.errors';
import { duplicateCode } from './specialties.service';

export interface RegionRecord {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

/**
 * A region is a state or province (FR-20.11), and it is a ROW rather than an
 * enum for two reasons: the client adds one from the panel with no release
 * (FR-19.8), and if the granularity ever changes from states to something else
 * that is data, not a migration.
 *
 * M-06 owns the catalogue. Which regions a given provider serves is
 * `doctor_regions`, owned by M-05, because that is an attribute of the
 * provider - exactly as `doctors.specialty_id` is.
 */
@Injectable()
export class RegionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** What a patient picks from in their profile. Active regions only. */
  async listActive(): Promise<RegionRecord[]> {
    const rows = await this.prisma.region.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map(shape);
  }

  async listAll(): Promise<RegionRecord[]> {
    const rows = await this.prisma.region.findMany({ orderBy: { name: 'asc' } });
    return rows.map(shape);
  }

  async create(
    input: { code: string; name: string },
    actor: AuthenticatedActor,
  ): Promise<RegionRecord> {
    let created: Region;
    try {
      created = await this.prisma.region.create({ data: input });
    } catch (error) {
      throw duplicateCode(error, 'region');
    }
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'create',
      entityType: 'region',
      entityId: created.id,
      metadata: { code: input.code, name: input.name },
    });
    return shape(created);
  }

  async update(
    regionId: string,
    patch: { code?: string; name?: string; isActive?: boolean },
    actor: AuthenticatedActor,
  ): Promise<RegionRecord> {
    await this.require(regionId);

    // Deactivating a region a pool still depends on would quietly shrink every
    // assignment that matches on it, so it is refused while providers are in it.
    if (patch.isActive === false) {
      const members = await this.prisma.doctorRegion.count({ where: { regionId } });
      if (members > 0) {
        throw new AppException(
          CatalogueError.STILL_IN_USE,
          `${members} provider(s) still serve this region. Remove them from it first.`,
          HttpStatus.CONFLICT,
        );
      }
    }

    let updated: Region;
    try {
      updated = await this.prisma.region.update({ where: { id: regionId }, data: patch });
    } catch (error) {
      throw duplicateCode(error, 'region');
    }
    await this.audit.record({
      actorType: 'admin',
      actorId: actor.id,
      action: 'update',
      entityType: 'region',
      entityId: regionId,
      metadata: { fields: Object.keys(patch) },
    });
    return shape(updated);
  }

  /** Used by M-04 before it writes a region onto a patient row. */
  async assertUsable(regionId: string): Promise<void> {
    const region = await this.require(regionId);
    if (!region.isActive) {
      throw new AppException(
        CatalogueError.REGION_NOT_FOUND,
        'That region is no longer available.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async require(regionId: string): Promise<Region> {
    const found = await this.prisma.region.findUnique({ where: { id: regionId } });
    if (!found) {
      throw new AppException(
        CatalogueError.REGION_NOT_FOUND,
        'That region does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return found;
  }
}

function shape(region: Region): RegionRecord {
  return { id: region.id, code: region.code, name: region.name, isActive: region.isActive };
}
