import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as z from 'zod';

import { AuditService } from '../audit/audit.service';
import { ActorType, AdminPermissionLevel, AuthenticatedActor } from '../common/auth';
import { AppException, PlatformError } from '../common/errors';
import { env } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';

export interface ConfigDefault {
  key: string;
  value: Prisma.InputJsonValue;
  description?: string;
  /**
   * The shape this value must have, as the owning module reads it.
   *
   * *** THIS IS WHAT MAKES AN EDITING ENDPOINT SAFE. *** Without it, an admin
   * panel writing straight to this table could put `"banana"` where the billing
   * code expects a number, and nothing would notice until the next checkout
   * failed for every patient. The module that reads a value is the only one
   * that knows its shape, so it declares it here alongside the default.
   */
  schema?: z.ZodType;
  /**
   * Which admin levels may change it. Absent means NOBODY can, through the
   * generic endpoint.
   *
   * A per-key list rather than one blanket permission, because these values are
   * not equivalent: a GST rate is finance's, a red-flag threshold is clinical
   * governance's, and the audit retention period is nobody's but a super
   * admin's. `super_admin` passes everything, as it does everywhere else.
   */
  editableBy?: AdminPermissionLevel[];
  /**
   * Set where a value HAS a dedicated screen of its own. The generic endpoint
   * then refuses to edit it and says where to go - two ways to change one value
   * is how the two drift apart, and the specialised screen usually validates
   * something this one cannot (a notification template's placeholders, for
   * instance).
   */
  managedBy?: string;
}

/** A registered value, as the admin panel lists it. */
export interface ConfigEntry {
  key: string;
  description: string | null;
  value: Prisma.JsonValue | undefined;
  /** False when the caller's level may not change this one. */
  editable: boolean;
  /** Where to edit it instead, when it has its own screen. */
  managedBy: string | null;
  updatedAt: Date | null;
}

interface CacheEntry {
  value: Prisma.JsonValue | undefined;
  expiresAt: number;
}

/**
 * Configuration held as data (SRS 5.2, 6.6). Values are owned by the module
 * that uses them - this service is only the store, the cache and the audit
 * trail behind them. Secrets never live here; they come from the environment.
 *
 * A value is cached per instance for APP_CONFIG_CACHE_TTL_MS, so a change made
 * in the admin panel is live within that window across every instance.
 */
@Injectable()
export class AppConfigService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = env().APP_CONFIG_CACHE_TTL_MS;

  /**
   * *** THE REGISTRY, ASSEMBLED BY THE MODULES THAT OWN THE VALUES. ***
   *
   * Not a constant in this file. Every entry is put here by the module that
   * seeds it, in the same call, so a key and its shape and its permission
   * cannot drift apart - and a value nobody registered is a value nobody can
   * edit, which is the correct answer for one this service has never heard of.
   *
   * In memory rather than in a table because it describes CODE: which module
   * reads the value and what it expects. Storing it would let the description
   * of a value disagree with the code that reads it, which is the whole class
   * of bug this codebase spends its schema comments avoiding.
   */
  private readonly registry = new Map<string, ConfigDefault>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Reads a value, validated against the shape the calling module expects. */
  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const raw = await this.read(key);
    if (raw === undefined || raw === null) return undefined;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Stored by an admin, so this is bad data rather than a bad request.
      throw new AppException(
        PlatformError.CONFIG_INVALID,
        `Configuration value "${key}" does not have the expected shape`,
        HttpStatus.INTERNAL_SERVER_ERROR,
        z.prettifyError(parsed.error),
      );
    }
    return parsed.data;
  }

  /** As `get`, but a missing key is a misconfigured platform, not an empty result. */
  async getOrThrow<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    const value = await this.get(key, schema);
    if (value === undefined) {
      throw new AppException(
        PlatformError.CONFIG_MISSING,
        `Configuration value "${key}" is not set`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return value;
  }

  /**
   * Writes a value and records who changed it from what to what. That audit
   * entry is the config history, which is why there is no versions table.
   */
  async set(
    key: string,
    value: Prisma.InputJsonValue,
    actor: { type: ActorType; id?: string | null },
    description?: string,
  ): Promise<void> {
    const before = await this.prisma.appConfig.findUnique({ where: { key } });
    await this.prisma.appConfig.upsert({
      where: { key },
      create: { key, value, description },
      update: { value, ...(description === undefined ? {} : { description }) },
    });
    this.cache.delete(key);

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: before ? 'update' : 'create',
      entityType: 'app_config',
      entityId: key,
      metadata: { before: before?.value ?? null, after: value },
    });
  }

  /**
   * Installs a module's defaults on first boot. Existing values are left alone,
   * so a deployment never overwrites what an admin has set.
   */
  async seed(defaults: ConfigDefault[]): Promise<void> {
    if (defaults.length === 0) return;
    // Registered even when the row already exists: seeding installs the value
    // once, but the shape and the permission describe the CODE and are true on
    // every boot.
    for (const entry of defaults) this.registry.set(entry.key, entry);

    await this.prisma.appConfig.createMany({
      data: defaults.map(({ key, value, description }) => ({ key, value, description })),
      skipDuplicates: true,
    });
    for (const entry of defaults) this.cache.delete(entry.key);
  }

  // -- The admin panel ------------------------------------------------------

  /**
   * Every registered value, with what it is for and whether this admin may
   * change it.
   *
   * Registered ones only. A row in the table that no module claims is not
   * offered for editing: nothing reads it, so changing it would do nothing,
   * and showing it would imply otherwise.
   */
  async listForAdmin(actor: AuthenticatedActor): Promise<ConfigEntry[]> {
    assertAdmin(actor);
    const rows = await this.prisma.appConfig.findMany({
      where: { key: { in: [...this.registry.keys()] } },
    });
    const stored = new Map(rows.map((row) => [row.key, row]));

    return [...this.registry.values()]
      .map((entry) => {
        const row = stored.get(entry.key);
        return {
          key: entry.key,
          description: row?.description ?? entry.description ?? null,
          value: row?.value,
          editable: entry.managedBy === undefined && this.mayEdit(actor, entry),
          managedBy: entry.managedBy ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Change one value from the admin panel.
   *
   * Three gates, in the order that tells the caller the most useful thing:
   * the key must be one a module registered, this admin's level must be one
   * that owns it, and the new value must parse as the shape the reading module
   * expects. The third is the one that matters - a config table is the easiest
   * place in a platform to put a number where a boolean goes and not find out
   * until something silently stops working.
   */
  async setFromAdmin(key: string, value: unknown, actor: AuthenticatedActor): Promise<ConfigEntry> {
    assertAdmin(actor);
    const entry = this.registry.get(key);
    if (!entry) {
      throw new AppException(
        PlatformError.CONFIG_MISSING,
        `There is no configuration value called "${key}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (entry.managedBy) {
      throw new AppException(
        PlatformError.FORBIDDEN,
        `This value is edited on the ${entry.managedBy} screen, which validates it properly.`,
        HttpStatus.CONFLICT,
        { managedBy: entry.managedBy },
      );
    }
    if (!this.mayEdit(actor, entry)) {
      throw new AppException(
        PlatformError.INSUFFICIENT_PERMISSION,
        'Your admin role does not have access to this setting.',
        HttpStatus.FORBIDDEN,
      );
    }

    const parsed = entry.schema ? entry.schema.safeParse(value) : ({ success: false } as const);
    if (!parsed.success) {
      throw new AppException(
        PlatformError.CONFIG_INVALID,
        'That value is not the right shape for this setting.',
        HttpStatus.BAD_REQUEST,
        entry.schema && 'error' in parsed ? z.prettifyError(parsed.error) : undefined,
      );
    }

    await this.set(key, parsed.data as Prisma.InputJsonValue, {
      type: 'admin',
      id: actor.id,
    });

    const row = await this.prisma.appConfig.findUnique({ where: { key } });
    return {
      key,
      description: row?.description ?? entry.description ?? null,
      value: row?.value,
      editable: true,
      managedBy: null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** `super_admin` passes everything, as it does everywhere else. */
  private mayEdit(actor: AuthenticatedActor, entry: ConfigDefault): boolean {
    if (actor.type !== 'admin') return false;
    if (actor.level === 'super_admin') return true;
    return Boolean(actor.level && entry.editableBy?.includes(actor.level));
  }

  private async read(key: string): Promise<Prisma.JsonValue | undefined> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await this.prisma.appConfig.findUnique({ where: { key } });
    // A miss is cached too, so an unset optional key is not a query per request.
    this.cache.set(key, { value: row?.value, expiresAt: Date.now() + this.ttlMs });
    return row?.value;
  }
}

function assertAdmin(actor: AuthenticatedActor): void {
  if (actor.type !== 'admin') {
    throw new AppException(
      PlatformError.FORBIDDEN,
      'Configuration is managed from the admin panel.',
      HttpStatus.FORBIDDEN,
    );
  }
}
