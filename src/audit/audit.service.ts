import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ActorType } from '../common/auth';
import { PrismaService } from '../database/prisma.service';

/** The kinds of thing worth remembering (`audit_action`). */
export type AuditAction =
  'create' | 'read' | 'update' | 'delete' | 'export' | 'login' | 'verify' | 'webhook';

export interface AuditEntry {
  actorType: ActorType;
  /** Null for `system`. */
  actorId?: string | null;
  action: AuditAction;
  /** The table or concept touched, e.g. `app_config`, `consultation`. */
  entityType: string;
  entityId: string;
  /** Set wherever the entry belongs to one consultation (SRS 6.7). */
  consultationId?: string | null;
  /** Before/after for a config change, the payload for a webhook, the identifier for a login. */
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

/** Only what Postgres will accept as `inet`; a malformed value must not lose the entry. */
const IP_ADDRESS = /^[0-9a-fA-F.:]{3,45}$/;

/**
 * The append-only trail every module writes to (SRS 6.7, MODULES M-01). It is
 * also the login-attempt log that M-02 rate limits from, which is why counting
 * lives here rather than in a second table.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one entry. A failure here is logged, never thrown: losing the trail
   * of an action is bad, failing the action itself because of it is worse.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          entityType: entry.entityType.slice(0, 80),
          entityId: entry.entityId.slice(0, 80),
          consultationId: entry.consultationId ?? null,
          metadata: entry.metadata,
          ipAddress: entry.ipAddress && IP_ADDRESS.test(entry.ipAddress) ? entry.ipAddress : null,
        },
      });
    } catch (error) {
      this.logger.error({ err: error, entry }, 'Failed to write audit entry');
    }
  }

  /** How many matching entries were written since `since`. Reads the rate limits. */
  async countSince(filter: {
    action: AuditAction;
    entityType: string;
    entityId?: string;
    /** Narrows to one client address, for a limit that must not be dodged by changing the number. */
    ipAddress?: string;
    since: Date;
  }): Promise<number> {
    return this.prisma.auditLog.count({
      where: {
        action: filter.action,
        entityType: filter.entityType,
        ...(filter.entityId !== undefined ? { entityId: filter.entityId } : {}),
        ...(filter.ipAddress ? { ipAddress: filter.ipAddress } : {}),
        createdAt: { gte: filter.since },
      },
    });
  }
}
